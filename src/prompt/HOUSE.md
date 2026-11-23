# HOUSE.md for Earshot (conductor, 18:14; block from KIT/house/BUILDER-CONSTRAINTS.md, direction OVERPRINT from KIT/house/VISUAL-DIRECTIONS.md)

CONSTRAINTS (house rules. They override your defaults. Where a rule and a habit conflict, the rule wins.)

SLOTS
- Verb: Hear this chart
- Input from the room: any chart image: pasted with Ctrl+V, chosen with the file picker, dragged in, or taken with the camera. On stage: a phone photo of a chart, taken from a seat
- Held-out record: the data file each of tonight's charts was drawn from (BOARD/DATA.md), matched by the chart's printed title; never sent to the model
- Visual direction: OVERPRINT. Its full brief is pasted below this block. Follow it exactly.
- Interface language: ENGLISH. One language. No switch.

PRODUCT
1. One screen, one verb. No navigation, tabs, settings, sign-in, landing page, onboarding or second feature.
2. No chat box, no conversation, no assistant persona. The verb starts the model. The answer is placed on the object itself (the page, map, picture or board) as structured values.
3. The input comes from the room at demo time. Ship one fallback input, labelled "Sample".
4. Every value on screen opens its source in one tap: the exact span, region, row or arithmetic lights up.
5. Every value carries one source mark, a small square: solid for Read (taken directly from the input), half-filled for Derived (computed from read values), hollow for Guessed (no direct evidence). Never show a confidence percentage.
6. "Verify" is a separate control that runs only when pressed. It compares each of the model's values with the held-out record using plain code. The held-out record must not appear in any prompt, context or tool result the model receives. Outcomes: Match, Mismatch (both values and the difference), Not known. Each outcome names the record.
7. "Not known" is a designed result at full size, not an error: "Not known: <what is missing>. To find out: <what would settle it>." The runtime prompt must tell the model to answer not known instead of filling in.
8. A status line under the title, always visible, with measured numbers: "<model id> read <N> <things> in <S> s." and, after Verify, "<A> match, <B> mismatch, <C> not known." While working: "Reading <thing> <n> of <N>. <S> s so far." No spinner.
9. A "Prompt" link, alone in the top end corner, opens a full-screen sheet with the exact runtime prompt, word for word, in the text family, ending with: "The model was not given: <held-out fields>."
10. A footer of three short lines: "Live: ..." (computed on every use), "Cached: ... at <time>" (computed earlier tonight), "Fixed: ..." (static data and its source). Anything mocked is named there.
11. A "Break it" control next to "Sample" loads one input prepared to fail and runs it through the same live path.
12. Phone first: one column, usable with one thumb at 360 px wide. Then the same screen at laptop width.

LOOK
13. Use only what the pasted direction brief names: its colours by hex and job, its families and weights, its layout, its proof marks, its motion. Add no colour, font, effect or component of your own.
14. Refuse: purple, indigo, violet; any gradient; glass or blur; glow; drop shadows; dark theme; cream with a clay accent; near-black with neon; grids of equal cards; boxes inside boxes; a centred headline with subtitle and two buttons; an icon above a heading; a coloured stripe down one side of a panel; decorative pills and badges; emoji; icon sets; avatars; mascots; small decorative charts; shimmering placeholders; pop-up messages; dialog boxes.
15. Refuse: Inter, Roboto, Arial, Open Sans, Space Grotesk, system-ui, Heebo, Rubik or Assistant as the main family; any code font, including for the prompt; all-caps labels; letter-spaced small labels above headings; middle dots joining labels; an arrow after button text; one word of a headline in another colour.
16. Sizes in CSS pixels at 100 % zoom. Laptop: nothing under 18, sentences 22, values 36, the one main statement at least 96. Phone: nothing under 16, sentences 18, values 28, the statement at least 48. No stroke under 2 px. No weight under 400. Tap targets at least 56 px tall. At most 15 lines of text visible at once. The layout holds at 125 % and 150 % browser zoom with no sideways scroll.
17. State is colour plus shape plus a word. Never colour alone.
18. Motion only where the model or the user changed something: results drawn on once (under 1.5 s in total) and one state change on Verify (about 200 ms each). Nothing loops, bounces, fades in on scroll or depends on hover. Honour reduced motion.

WORDS
19. Sentence case. Digits and units. No exclamation marks, no "I", no "we", no apology, no greeting, no tagline.
20. The first sentence on the page says what to supply and what will be checked.
21. Buttons: the verb and its object, three words at most. The same word names an action everywhere. Fixed labels: Verify, Prompt, Break it, Sample, Run again.
22. Banned: AI-powered, smart, intelligent, assistant, copilot, companion, magic, insights, seamless, effortless, unlock, empower, supercharge, transform, journey, simply, oops, sorry, welcome, get started, learn more, try it now, something went wrong, verified (say "Match").
23. Errors, three short sentences at most: what happened, what state things are in now, what to press.
24. The product name is a concrete noun plus a real number from its data. No "AI", no "-ify" or "-ly", no Hub, Flow, Sense, Pulse, Mate, Genie, Buddy. No logo.
25. If Hebrew: direction and language are set on the root in the markup; layout uses start and end, never left and right; numbers, units, the model id, links and English terms run left to right and are isolated from the Hebrew around them; text of unknown direction (model output, pasted input, source spans) gets automatic direction; buttons are action nouns, instructions are plural imperatives; no slanted or letter-spaced Hebrew; never the section sign.

DONE MEANS, FOR THESE CONSTRAINTS
26. A stranger names the verb within 5 seconds. Every value opens its source. Verify returns all three outcomes on prepared inputs. The status line shows measured numbers. The Prompt sheet opens and matches what is sent. Nothing listed in 14, 15 or 22 appears anywhere.

EARSHOT ADDITIONS (written by the conductor at 18:14; where they conflict with the block above, these win)
A. The user is blind or has low vision. Everything works by keyboard alone and by screen reader alone: real buttons, visible focus, labels on every control, one polite live region that announces status, results, Verify outcomes and refusals. Nothing needs a mouse or sight.
B. Item 4 "one tap" also means one key: Enter on a value announces and marks its source.
C. Item 12 (phone first) is cut tonight: the demo is driven by keyboard on a laptop. The layout must hold at laptop width and at 125% and 150% zoom.
D. Sound is part of the result: the chart played as pitch, then spoken. Every sound has a text equivalent on screen and in the live region.
E. Item 24: the spoken name is "Earshot". The on-screen title may add a real number from the data.
F. Under the clock the conductor cuts items 11, 5, 10 in that order, and says so.

## DIRECTION: OVERPRINT

**Idea.** A survey sheet. The existing record is printed in navy ink; whatever the model adds is
overprinted in magenta, and a claim turns to ink only when a check confirms it.

**Palette.** Seven colours, each with one job. No others.

- Sheet, #F6F8FA: the ground of the whole page, a cool paper white. Never cream.
- Ink navy, #12264A: everything that belongs to the record: base text, base lines, the title, and the
  fill of the verb button (white label).
- Graticule, #A9BCD0: grid lines, edge ticks and rules. Lines only. Never text.
- Overprint magenta, #C5006C: everything the model produced that has not been confirmed: its text, its
  outlines, its leader lines. A flat pink-red, not a purple.
- Overprint tint, #FBE3F0: the fill behind a region the model read from. Fill only.
- Benchmark green, #0A7B45: the match mark, and nothing else.
- Margin grey, #4E5F75: units, captions, the footer.

**Type.** IBM Plex Sans Hebrew for all text in both scripts: weight 400 for sentences, 600 for values
and labels, 700 for the main statement. IBM Plex Sans Condensed (Latin only), weight 500 or 600, for
digits that sit on the sheet itself: coordinates, edge ticks, counts next to marks. No other family.
No code font.

**Layout.**

- The object is the sheet and fills the screen edge to edge. Nothing floats over it in a box.
- One margin band holds all words: the title line, the verb, the status line, the selected claim, the
  footer. On a phone it is a band along the bottom, at most 40 % of the height. On a laptop it is a
  column 360 to 420 px wide on the end side (right in English, left in Hebrew).
- The sheet has edge ticks with real units (metres, minutes, page numbers, coordinates). If the object
  has no real scale, there are no ticks. Ticks are information, not decoration.
- The model's claims attach to the sheet with a straight 2 px leader line from the label to the point.
  No pins, no balloons, no cards.
- Square corners everywhere. No shadows. Text is start-aligned.

**Proof.**

- Unchecked claim: magenta text, magenta 2 px outline on the region it refers to, tint fill.
- Match: the claim's text and outline turn ink navy. It has joined the record. A solid green triangle
  stands before it, with the word "Match", both values ("model 21 m, record 21 m") and the record's name.
- Mismatch: the claim stays magenta. Its value is struck through with a 3 px line, and the record's
  value is printed beside it in ink navy. A solid magenta block with a white label says "Mismatch"
  and gives the difference.
- Not known: a dashed magenta outline around the region, filled with diagonal hatching in the tint.
  The words "Not known" and the reason. No number is shown.

**Motion.** When the model returns, the overprint is drawn on once: outlines trace in reading order,
400 to 600 ms each, 1.5 s in total at most. On Verify, each claim changes state in about 200 ms, one
after another. The view moves only when the user moves it. Nothing loops. With reduced motion,
everything appears at once.

**Forbidden.** Dark map styles. Teardrop map pins. Emoji or icon markers. Rainbow colour scales (use
steps of magenta). Rounded panels floating over the map. Glass, blur, glow, shadows, gradients, fog in
3D scenes. A second accent colour. All-caps labels. Purple or violet in place of the magenta.

---

