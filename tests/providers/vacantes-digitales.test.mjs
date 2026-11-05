/**
 * Vacantes Digitales provider — unit tests.
 *
 * Cases below are shapes observed on the live feed plus the boundary cases that
 * matter for the scanner: a bad `url` must not become a dedup key, `company`
 * arrives as both an object and a bare string, and `location_type` is what makes
 * a LatAm remote posting legible to location_filter.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import provider, { normalize, buildLocation } from "../../providers/vacantes-digitales.mjs";

test("id is stable and detect() is opt-in", () => {
  assert.equal(provider.id, "vacantes-digitales");
  assert.equal(provider.detect({ provider: "greenhouse", careers_url: "https://vacantesdigitales.com" }), null);
  assert.ok(provider.detect({ careers_url: "https://vacantesdigitales.com" }));
  assert.equal(provider.detect({ careers_url: "https://evil.example.com" }), null);
});

test("normalize: happy path", () => {
  const job = normalize({
    title: "  AI Engineer (GenAI / RAG)  ",
    url: "https://vacantesdigitales.com/empleo-digital/ai/ai-engineer",
    company: { name: "Acme", slug: "acme", industry: "SaaS" },
    location_type: "Remoto",
    address_country: "CO",
    address_locality: "Bogotá",
    date_posted: "2026-09-20T10:00:00.000Z",
    experience_level: "Semi Senior",
    skills: ["Python", "RAG"],
    apply_url: "https://www.linkedin.com/feed/update/urn:li:activity:75017263723948810",
  });
  assert.equal(job.title, "AI Engineer (GenAI / RAG)");
  assert.equal(job.company, "Acme");
  // Remote must survive — it is the signal location_filter matches on.
  assert.match(job.location, /Remote/);
  assert.match(job.location, /Colombia/);
  assert.equal(job.postedAt, Date.parse("2026-09-20T10:00:00.000Z"));
  assert.equal(job.category, undefined); // not supplied in this record
  assert.deepEqual(job.skills, ["Python", "RAG"]);
  // apply_url is preserved but is NOT the dedup key.
  assert.match(job.applyUrl, /linkedin\.com\/feed\/update/);
});

test("normalize: company as bare string (older records)", () => {
  const job = normalize({ title: "Dev", url: "https://vacantesdigitales.com/x", company: "SoloDev" });
  assert.equal(job.company, "SoloDev");
});

test("normalize: rejects records unusable as dedup keys", () => {
  assert.equal(normalize(null), null);
  assert.equal(normalize({}), null);
  assert.equal(normalize({ title: "No URL", url: "" }), null);
  assert.equal(normalize({ title: "", url: "https://vacantesdigitales.com/x" }), null);
  // Off-host and non-https must not become dedup keys.
  assert.equal(normalize({ title: "Evil", url: "https://evil.example.com/x" }), null);
  assert.equal(normalize({ title: "Plain", url: "http://vacantesdigitales.com/x" }), null);
  assert.equal(normalize({ title: "Junk", url: "not-a-url" }), null);
});

test("buildLocation: remote and on-site are distinguishable", () => {
  assert.match(buildLocation({ location_type: "Remoto", address_country: "MX" }), /^Remote/);
  // A presencial posting must not read as remote.
  const onsite = buildLocation({ location_type: "Presencial", address_country: "MX", address_locality: "CDMX" });
  assert.doesNotMatch(onsite, /Remote/i);
  assert.match(onsite, /Presencial/);
  assert.match(onsite, /Mexico/);
  // Unknown country code degrades to the raw value rather than dropping it.
  assert.match(buildLocation({ address_country: "ZZ" }), /ZZ/);
  assert.equal(buildLocation({}), "");
});

test("fetch: paginates, dedupes, and stops at the server's page count", async () => {
  const calls = [];
  const ctx = {
    fetchJson: async (url) => {
      calls.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      if (page === 1) {
        return {
          data: [
            { title: "A", url: "https://vacantesdigitales.com/a", company: { name: "X" } },
            { title: "B", url: "https://vacantesdigitales.com/b", company: { name: "X" } },
            // duplicate URL within the page — must be dropped
            { title: "B again", url: "https://vacantesdigitales.com/b", company: { name: "X" } },
            { title: "bad", url: "https://evil.example.com/x" },
          ],
          pagination: { page: 1, limit: 10, total: 3, pages: 2 },
        };
      }
      if (page === 2) {
        return { data: [{ title: "C", url: "https://vacantesdigitales.com/c" }], pagination: { page: 2, pages: 2 } };
      }
      return { data: [], pagination: { page, pages: 2 } };
    },
  };

  const jobs = await provider.fetch({}, ctx);
  assert.deepEqual(jobs.map(j => j.title), ["A", "B", "C"]);
  assert.equal(calls.length, 2, "stops at pagination.pages, does not probe page 3");
  assert.ok(calls[0].startsWith("https://vacantesdigitales.com/api/list?"));
});

test("fetch: category filter is forwarded", async () => {
  let seen = "";
  await provider.fetch({ category: "inteligencia-artificial" }, {
    fetchJson: async (url) => { seen = url; return { data: [], pagination: { pages: 1 } }; },
  });
  assert.match(seen, /category=inteligencia-artificial/);
});

test("fetch: max_pages is clamped, and an early empty page stops the loop", async () => {
  let n = 0;
  const ctx = { fetchJson: async () => { n++; return { data: [], pagination: { pages: 999 } }; } };
  await provider.fetch({ max_pages: 5 }, ctx);
  assert.equal(n, 1, "empty first page ends the loop immediately");

  n = 0;
  const full = { fetchJson: async () => { n++; return { data: [{ title: "T", url: `https://vacantesdigitales.com/${n}` }], pagination: {} }; } };
  await provider.fetch({ max_pages: 3 }, full);
  assert.equal(n, 3, "max_pages honoured when the server reports no page count");
});
