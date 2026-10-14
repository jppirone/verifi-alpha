// node tools/resume/test-resume-heading-guard.ts   (no dependencies)
import assert from "node:assert/strict";
import { guardSelfReferentialHeadings, clearBoundaryHeadings, normalizeLabel } from "../../supabase/functions/_shared/resume-heading-guard.ts";

let n = 0; const t = (name: string, fn: () => void) => { fn(); n++; console.log("ok  ", name); };

t("normalize strips dates and punctuation", () => {
  assert.equal(normalizeLabel("SHRM-SCP Certification | 2020"), "shrmscpcertification");
  assert.equal(normalizeLabel("VP, People & Talent Strategy, Luminary Labs | Baltimore, MD March 2021 Present"), "vppeopletalentstrategyluminarylabsbaltimoremd");
});

t("the real Lisa Tom case: cert heading == first cert's own name + year is cleared on every item", () => {
  const ex: any = { certifications: [
    { name: "SHRM-SCP Certification", issuing_body: "SHRM", issue_date: "2020", heading: "SHRM-SCP Certification | 2020" },
    { name: "Prosci Change Management Certification", issuing_body: "Prosci", issue_date: "2019", heading: "SHRM-SCP Certification | 2020" },
  ] };
  const r = guardSelfReferentialHeadings(ex);
  assert.deepEqual(r, [{ section: "certifications", heading: "SHRM-SCP Certification | 2020" }]);
  assert.deepEqual(ex.certifications.map((c: any) => c.heading), ["", ""]);
  assert.equal(ex.certifications[0].name, "SHRM-SCP Certification"); // items untouched
});

t("a real certifications heading is kept", () => {
  const ex: any = { certifications: [{ name: "SHRM-SCP Certification", issuing_body: "SHRM", heading: "CERTIFICATIONS" }, { name: "Prosci", issuing_body: "", heading: "CERTIFICATIONS" }] };
  assert.deepEqual(guardSelfReferentialHeadings(ex), []);
  assert.equal(ex.certifications[0].heading, "CERTIFICATIONS");
});

t("a heading that only CONTAINS an item's name is kept (full-label equality only)", () => {
  const ex: any = { certifications: [{ name: "PMP", issuing_body: "PMI", heading: "Professional Certifications (PMP, CSM)" }] };
  assert.deepEqual(guardSelfReferentialHeadings(ex), []);
});

t("issuer-only / company-only / institution-only headings are legitimate grouping headings and are kept", () => {
  const ex: any = {
    certifications: [{ name: "PMP", issuing_body: "PMI", heading: "PMI" }],
    work_history: [{ title: "VP", company: "Luminary Labs", location: "Baltimore, MD", heading: "Luminary Labs" }],
    education: [{ institution: "University of Maryland", degree: "Bachelor of Science", field_of_study: "Psychology", heading: "University of Maryland" }],
  };
  assert.deepEqual(guardSelfReferentialHeadings(ex), []);
});

t("work history: heading == title+company(+place+dates) is LEFT UNCHANGED (upload-resume's merge rule owns this case since the AP6 re-run)", () => {
  const heading = "Director of Talent Acquisition, NorthBridge Technologies | Annapolis, MD June 2014 March 2021";
  const ex: any = { work_history: [{ title: "Director of Talent Acquisition", company: "NorthBridge Technologies", location: "Annapolis, MD", heading }] };
  assert.deepEqual(guardSelfReferentialHeadings(ex), []);
  assert.equal(ex.work_history[0].heading, heading);
});

t("the PironeBeast case: a work history title-as-heading is left alone while a certifications title-as-heading in the same input is still cleared", () => {
  const ex: any = {
    work_history: [
      { title: "Business Operations & Portfolio Manager", company: "Acme Corp", heading: "PROFESSIONAL EXPERIENCE" },
      { title: "Business Operations & Portfolio Manager", company: "Acme Corp", heading: "Business Operations & Portfolio Manager" },
    ],
    certifications: [
      { name: "SHRM-SCP Certification", issuing_body: "SHRM", issue_date: "2020", heading: "SHRM-SCP Certification | 2020" },
      { name: "Prosci Change Management Certification", issuing_body: "Prosci", issue_date: "2019", heading: "SHRM-SCP Certification | 2020" },
    ],
  };
  const r = guardSelfReferentialHeadings(ex);
  assert.deepEqual(r, [{ section: "certifications", heading: "SHRM-SCP Certification | 2020" }]);
  assert.deepEqual(ex.work_history.map((w: any) => w.heading), ["PROFESSIONAL EXPERIENCE", "Business Operations & Portfolio Manager"]);
  assert.deepEqual(ex.certifications.map((c: any) => c.heading), ["", ""]);
  // and the boundary list keeps the work history heading (nothing was rejected for it)
  const secs = clearBoundaryHeadings([{ heading: "Business Operations & Portfolio Manager", category: "work_history" }, { heading: "SHRM-SCP Certification | 2020", category: "certifications" }], r);
  assert.deepEqual(secs.map((s) => s.heading), ["Business Operations & Portfolio Manager", ""]);
});

t("education: heading == degree line (with institution / date) is cleared; heading 'EDUCATION' is kept", () => {
  const a: any = { education: [{ institution: "University of Maryland", degree: "Bachelor of Science", field_of_study: "Business", heading: "Bachelor of Science, University of Maryland | 2008" }] };
  assert.equal(guardSelfReferentialHeadings(a).length, 1); assert.equal(a.education[0].heading, "");
  const b: any = { education: [{ institution: "University of Maryland", degree: "Bachelor of Science", field_of_study: "Business", heading: "EDUCATION" }] };
  assert.deepEqual(guardSelfReferentialHeadings(b), []); assert.equal(b.education[0].heading, "EDUCATION");
});

t("skills: heading identical to one skill is cleared (and the boundary list follows)", () => {
  const ex: any = { skills: ["Python", "SQL"], skills_heading: "Python" };
  const r = guardSelfReferentialHeadings(ex);
  assert.equal(ex.skills_heading, ""); assert.equal(r[0].section, "skills");
  const secs = clearBoundaryHeadings([{ heading: "Python", category: "skills" }, { heading: "EDUCATION", category: "education" }], r);
  assert.deepEqual(secs.map((s) => s.heading), ["", "EDUCATION"]);
});

t("freeform: heading == the whole content or its first line is cleared; a real heading is kept", () => {
  const ex: any = { freeform: [
    { section_type: "additional_info", heading: "Volunteer Board Member, Habitat 2019", content: "Volunteer Board Member, Habitat\nBuilt homes" },
    { section_type: "summary", heading: "SUMMARY", content: "Strategic talent executive" },
  ] };
  const r = guardSelfReferentialHeadings(ex);
  assert.equal(r.length, 1); assert.equal(ex.freeform[0].heading, ""); assert.equal(ex.freeform[1].heading, "SUMMARY");
});

t("short / empty headings are never treated as a match; nothing throws on missing fields", () => {
  const ex: any = { certifications: [{ name: "AB", heading: "AB" }, { heading: "" }], work_history: [], education: undefined };
  assert.deepEqual(guardSelfReferentialHeadings(ex), []);
  assert.deepEqual(guardSelfReferentialHeadings({}), []);
});

t("boundary headings are cleared in step with the items, only for the matching category", () => {
  const rej = [{ section: "certifications", heading: "SHRM-SCP Certification | 2020" }];
  const secs = clearBoundaryHeadings([{ heading: "SHRM-SCP Certification | 2020", category: "certifications" }, { heading: "SHRM-SCP Certification | 2020", category: "skills" }], rej);
  assert.deepEqual(secs.map((s) => s.heading), ["", "SHRM-SCP Certification | 2020"]);
});

console.log(`\n${n} tests passed`);
