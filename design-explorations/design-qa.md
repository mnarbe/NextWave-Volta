# Design QA — Volta explorations

## Evidence

- Source visual truth:
  - `references/negotiation-flow.png` — 1487 × 1058 px.
  - `references/market-pulse.png` — 1487 × 1058 px.
  - `references/living-manifest.png` — 1487 × 1058 px.
- Browser-rendered implementation:
  - `screenshots/a-negotiation-flow-desktop.png` — 1440 × 1000 px.
  - `screenshots/b-market-pulse-desktop.png` — 1440 × 1000 px.
  - `screenshots/c-living-manifest-desktop.png` — 1440 × 1000 px.
  - Mobile captures are 390 × 844 px for all three directions.
- Combined comparison: `screenshots/qa-comparison.png`.
- State: representative winner state with active call, fresh offer, one late offer and one over-cap offer.
- Density normalization: CSS pixels at device scale 1. The generated direction images use a slightly different aspect ratio, so full-view comparison was normalized into equal-height 480 px frames in `qa-comparison.html`. Fidelity was judged at the level of hierarchy, composition, typography, semantic color and copy rather than literal pixel matching.

## Full-view comparison

- A preserves the source's mandate → parallel lanes → convergence structure, while replacing decorative icons with state markers and enlarging the narrative headline.
- B preserves the cap line and spatial price comparison; the eligibility explanation remains visible as the next section and the late rejection is already explicit on the price field.
- C preserves the two-sheet operational composition, paper hierarchy, carrier slips and state stamps; the decision is placed inside the mandate sheet to improve mobile ordering.

## Focused comparison

- Carrier price, name and rejection cause were inspected in each direction because these are the core 15-second comprehension surfaces.
- Mobile mandate and decision ordering was inspected separately at 390 × 844 and again for overflow and target size at 360 px.
- Technical evidence drawers, scenario controls and carrier expansion were checked as interaction surfaces rather than visual-only chrome.

## Required fidelity surfaces

- Fonts and typography: human serif display + restrained sans UI + mono operational data are consistent in all three directions; line lengths and hierarchy remain readable at 390 px.
- Spacing and rhythm: desktop compositions retain the intended negative space; mobile uses a distinct ordering rather than compressed desktop columns.
- Colors and tokens: A uses warm graphite/amber/coral/green; B uses paper/forest/coral/ochre; C uses warm manifest paper/ink/coral/green. Semantic states are consistent and do not depend on color alone.
- Image and asset quality: the concepts are interface-led and require no raster imagery. Structural lines, rules and markers are native interface elements; no placeholder imagery or emoji icons remain.
- Copy and content: the mandate, three carrier offers, late disqualifier, over-cap state and deterministic winner match the repository's domain rules and the supplied comparison data.

## Comparison history

### Pass 1

- [P2] A mobile placed the decision below the first viewport. Fixed by compacting the mandate summary and reordering the decision directly after it.
- [P2] B mobile did not surface the 9.000 MXN maximum before the market. Fixed by adding the maximum to the mandate strip.
- [P2] Scenario navigation exposed native horizontal scrollbars and brand links had sub-44 px targets. Fixed by hiding only the nav scrollbar and expanding clickable targets without hiding content.

### Pass 2

- Post-fix captures show mandate and decision near the start in all three mobile directions.
- At 360 px, document width remains inside the viewport and every visible button, summary and link is at least 44 × 44 px.
- Result, no-winner, intervention, disconnected/reconnect, carrier expansion and confirmation states work; browser console errors: none.
- No actionable P0/P1/P2 findings remain.

## Follow-up polish

- [P3] If a direction is selected, replace system font fallbacks with a final locally served type pairing and tune optical sizes in the production pass.
- [P3] Motion timing should be calibrated against real WebSocket event cadence once integrated.

final result: passed
