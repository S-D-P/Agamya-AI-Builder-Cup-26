# Agamya build checklist

Baseline before changes (2026-10-13): `npm test` → 50/50 pass (offline, fake model).

## Engine (shared)
- [ ] Migration 002: space type on organizations (`work` | `living`), sample spaces, knowledge sharing and governance columns, transfer plans, session ↔ transfer link
- [ ] Knowledge visibility enforced server-side (private / named people / whole space) in list, detail, lessons, attempts, scenario visuals, AI retrieval and cross-expert checks
- [ ] Contributor-only sharing controls, restriction flag, attribution, craft context; withdraw knowledge (purges evidence media)
- [ ] Living spaces default to private; work spaces default to organization-shared (disclosed before capture)
- [ ] Voice provider abstraction (Google default; others pluggable)

## Agamya for Living Knowledge
- [ ] Kitchen camera source + "Amma's ghee" skill (judgment by sensory signal, boundary, counterexample)
- [ ] Living shell and screens: home, capture a skill, my knowledge, learning, sharing and permissions
- [ ] Featured journey guide driven by real state; per-visitor sample space; honest disclosures

## Agamya for Work
- [ ] Transfer plans: manager schedules expert → learner; expert sees disclosure, starts capture from the plan
- [ ] Learner progress: demonstrated in simulation / needs supervision / not started, with gaps
- [ ] Work sample space (per visitor) with the three existing workflows and one scheduled transfer

## Product
- [ ] Rebrand KINDRED → Agamya; landing page with two experiences; demo persona gallery removed
- [ ] Original pearl companion mascot; sage/coral restrained visual system
- [ ] No inert controls; AI-offline state shown honestly

## Verification and delivery
- [ ] New tests: visibility, sharing authz, transfers authz, sample-space isolation, kitchen pipeline
- [ ] `npm test`, live acceptance (all three work workflows + the living journey)
- [ ] Browser walkthrough (desktop + mobile)
- [ ] README, docs, demo script, measured results, submission checklist
- [ ] Deploy to Cloud Run if credentials allow; verify URL
