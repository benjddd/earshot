MASTER PROMPT for Earshot · version 1 · written by the conductor from Ben's decisions · sent 18:15, 23 November 2026

OBJECTIVE
Build Earshot: it lets a blind person hear a chart they were sent as a picture, by having claude-fable-5-2 read the
exact values out of the image, and shows it is right by checking them against data the model never saw.
Tonight's topic is "Accessibility. Build something that makes technology work for more people, whatever their
abilities."; this is about it because a chart sent as a picture is silent to a screen reader, and Earshot makes it heard.
It will be shown in a two-minute live demo to developers, driven by keyboard only. A judge may give it an image you have not seen.

CONSTRAINTS
- Stack: Vite, vanilla JS, no framework, no TypeScript, no test suite. Static site plus one serverless function on
  Vercel. No login, no database.
- You are the only session that writes app code. You never run git and never deploy: at each checkpoint you announce
  CHECKPOINT as your role brief says, and the release manager deploys it. Read BOARD/PRODUCT.md and BOARD/SCOPE.md first.
- The model call follows BOARD/MODEL-CALL.md exactly: claude-fable-5-2, effort high, the image and the fixed
  instructions in, nothing else. The image is redrawn on a canvas in the browser before upload (long edge at most
  2000 px, JPEG, under 4 MB). The withheld data never reaches the model by any route.
- The model key is read from the environment on the server side only. Never print it, log it or send it to the page.
- The product is itself accessible, and this is checked: every action works by keyboard alone and by screen reader
  alone. Real buttons, visible focus, a label on every control, one polite live region that announces status,
  results, Verify outcomes and refusals. Large high-contrast type. Nothing needs a mouse or sight. Every sound has
  the same content as text.
- Honesty on screen: a cached reading is labelled cached with its time; the previous model's reading is labelled
  "claude-fable-5-1, captured <time> tonight"; when the model returns null or not known the page shows and speaks
  "Not known: <what is missing>. To find out: <what would settle it>.", never a guess and never an invented note.
- The comparison with the previous model appears only for tonight's photographed charts. A clean upload goes to the
  new model alone and no gap is claimed.
- Designed for a laptop driven by keyboard, readable from the back row; holds at 125% and 150% zoom. The phone
  layout is cut.
- This prompt is served at /prompt as plain large text with the time it was sent, followed in full by the house
  rules file, so nothing that was used is hidden. It opens the demo.
- House rules: follow BOARD/HOUSE.md in full; where it and a habit conflict, it wins. The one odd thing: the whole
  product can be used with the screen switched off.
- Out of scope: describing photos in general; a chat box; editing or redesigning the chart.

DATA
BOARD/DATA.md (scout, written tonight) names tonight's charts, the data each was drawn from, their printed titles,
and the files: the charts and Ben's phone photos of them in BOARD/proof/, the claude-fable-5-1 readings of the same
photos in BOARD/fallbacks/. Copy what you use into the project. The data is the withheld record: a static JSON file
in the site, fetched only when Verify is pressed, found by the chart's printed title as the model read it.
If a file is not there yet when you need it, build with the charts that are, and say so at the checkpoint.

STEPS (one step at a time; each ends in something heard or seen; after each CHECKPOINT wait for GO)
0. A page that builds: the name Earshot, and this prompt at /prompt.
   → CHECKPOINT cp0, then wait for GO.
Core (public by 18:30; alone it is a whole demo)
1. Input: one chart image by paste (Ctrl+V), file picker or drag, with the camera as one more option. "Sample"
   loads one of tonight's photos; "Break it" loads the glare photo through the same live path.
2. One model call. The values appear as a real HTML table beside the image; the status line says
   "claude-fable-5-2 read <N> values in <S> s."; the chart plays as pitch (higher value, higher note; one key plays
   it again); then the summary is spoken.
3. Verify, pressed by the user: each value against the withheld data in plain code, within the tolerance in
   BOARD/DATA.md. "<A> match, <B> mismatch, <C> not known", shown and spoken. A chart with no withheld record gives
   "Not known: no withheld data for this image."
4. The glare photo and any unreadable image give the spoken refusal, and no note is played for a missing value.
   → CHECKPOINT cp1: what works, what does not, what you assumed.
Then, in this order, each only after GO for the one before
5. Explore by keyboard: arrow keys step point by point with pitch and the spoken value; Home and End; a key for the
   trend; a key to switch series or panel. Spend at most ten minutes checking the open library chart2music (npm):
   if it fits, use it and name it in the footer; if not, plain Web Audio by hand. → CHECKPOINT cp2
6. Both melodies: for a photographed chart of tonight, "Play both" plays the new model's reading and the previous
   model's reading of the same photo, same settings, on one pitch scale wide enough that a wrong point is plainly
   heard; the differing points are marked on screen; then Verify shows which reading matches. → CHECKPOINT cp3
7. Ask a question, typed or spoken ("when did it peak?"): maximum, minimum and differences are computed by plain
   code from the table, not by the model, and the answer is shown and spoken. → CHECKPOINT cp4
8. Keep or share: a link to the heard chart with an accessible HTML table, an alt-text paragraph and a CSV
   download. → CHECKPOINT cp5
9. Redraw as proof: the chart redrawn from the numbers read, laid over the image. → CHECKPOINT cp6
10. Only when the conductor says so: the spoken summary in Hebrew.

DONE MEANS
- A stranger opening the URL on a laptop can paste or pick a chart image, with no mouse, and hear the chart and its
  summary within 30 seconds.
- For tonight's panel-grid photo the table shows the values in BOARD/DATA.md within the tolerance and Verify says Match.
- For the glare photo the page shows and speaks "Not known: ..." and plays no invented value.
- With the screen covered, a listener can load Sample, hear the chart, hear the summary and hear the Verify result,
  using the keyboard only.
- /prompt shows this text and BOARD/HOUSE.md in full; the Prompt link shows the runtime prompt word for word.
- The browser console shows no errors during the demo clicks.
- Nothing on the page claims more than BOARD/LEDGER.md says is live.
