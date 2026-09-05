# Rendered concept quality rubric v1

Read the PRD, selected wireframe and binding client preferences, then inspect the actual PNG from `scripts/capture-concept.mjs`. HTML source inspection alone is not visual evaluation. Never invent a screenshot or mark an unseen criterion pass. Act as a fresh reviewer, not the generator defending its output.

For EACH criterion return `criterionId`, `status` (`pass`, `fail`, `not-verified`), `observed`, `reason`, `remediation`, and `evidenceRefs` containing the captured PNG path. All criteria are required; no not-applicable shortcut. Identify the affected region/element in observed text. A pass still needs a concrete observation. Missing evidence is not-verified.

| criterionId | Pass anchor | Failure examples |
| --- | --- | --- |
| task-hierarchy | The first viewport communicates the product task and primary action; secondary actions are subordinate | Generic hero consumes the task area, competing primary buttons, title and body visually indistinguishable |
| content-specificity | Visible copy, labels and imagery serve the PRD's actual audience/task | Unrequested slogans, lorem ipsum, fabricated social proof, decorative placeholder icons passed off as finished assets |
| composition | Grouping matches information relationships and the approved structure | Every unrelated section wrapped in identical cards, meaningless bento panels, arbitrary symmetry obscuring priority |
| density-rhythm | Spacing and type scale create readable groups at the target viewport | Huge dead space between related controls, crushed labels, inconsistent row rhythm, unnecessary scrolling for the primary task |
| decoration-purpose | Color, shadows, icons, gradients and motion explain hierarchy, state or approved brand intent | Stock glow/gradient on every panel, arbitrary badges/emojis, excessive shadows and pills competing with content |
| brand-fidelity | Actual rendered color/font/mood follow explicit client requirements within the selected system | System default brand overriding client choice, silent font fallback, changing a requested color merely to avoid a trend |
| visual-finish | Text is readable and aligned, assets and state affordances are intentional | Clipped or overlapping labels, broken images, inconsistent icon weights, accidental overflow, low-contrast essential text |

Common patterns are not inherently failures. A card is appropriate for grouped content; a gradient may be explicitly requested. Do not reward novelty at the cost of usability. Explain why a treatment helps or harms THIS task. Preserve the wireframe's required sections, client colors/fonts and selected system; if those constraints themselves prevent a pass, report the conflict instead of silently changing them.

Scores are not used for release. All seven criteria must pass, alongside mechanical/spec/accessibility checks. Retry at most three repairs, recapturing after every change. This is AI visual critique with inspectable evidence, not empirical user research or proof of universally good taste.
