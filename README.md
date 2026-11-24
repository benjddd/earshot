# Hear the Chart

Hear the Chart is a free web app that turns a photo or screenshot of a chart into sound, speech and an accessible
table. It is built for blind and low-vision people who are handed a chart as a picture. It has not yet been tested
with screen-reader users.

Live at **https://hearthechart.com**.

## How it works

1. You photograph, upload, paste or drop a picture of a chart.
2. The browser redraws the picture as a JPEG (long edge at most 2000 px, no file name, no metadata) and sends it
   to Claude, Anthropic's model (`claude-fable-5-2`, effort `high`), with one fixed instruction: extract every
   value, and mark any value it cannot read as unknown with a reason instead of guessing.
3. The values come back as a table. Plain code on the page, not the model, derives the headline, the key facts
   and each series' trend from that table.
4. Each series plays as a continuous tone: a higher value is a higher pitch. A one-line headline is spoken with the
   browser's built-in voice and shown as text.
5. In the table, Left and Right step through a series with a note and the spoken value, Up and Down change series,
   Home and End jump to the ends, and T speaks the trend. P plays, A plays all series, K speaks the key facts,
   M turns the voice on or off, and Escape or Space stops all sound.
6. **Verify** compares the reading with data you supply (a CSV or JSON file), value by value, within 3 units or 5%,
   whichever is larger. The data file is read in your browser and never leaves the page.

The photo is sent to Claude to be read. This site does not store or log it.

## What has been checked, and how

- **Reading accuracy on test charts.** Three charts were drawn from known data (a heatmap, a 16-panel grid and a
  log-scale line chart), photographed on a phone from a laptop screen, and read by the app. Verify compared each
  reading with the source data. On the log-scale photo, `claude-fable-5-2` read 40 of 40 values within tolerance;
  the previous model, `claude-fable-5-1`, read 8, 9 and 11 of 40 over three runs with the same photo and settings.
  This is a small test, not a benchmark.
- **Unreadable values.** A photo with glare painted over part of the chart returned "Not known" with a reason for
  the covered points, rather than invented values.
- **Sound timing.** Speech and tones were checked by instrumenting the browser's speech and audio calls, so that
  no tone starts before a spoken sentence ends.
- **Not yet checked:** use with a screen reader (NVDA, JAWS, VoiceOver), use by blind or low-vision testers, and
  phone layouts beyond a quick look. Readings can be wrong; check against the source data when it matters.

## Origin

The first version was built in one evening at the Claude Fable 5.2 Build Day in Tel Aviv on 23 November 2026.
That exact build is tagged
[`build-day-2026-11-23`](https://github.com/benjddd/hear-the-chart/releases/tag/build-day-2026-11-23).
The current version removes the parts that existed only for the live demo and adds the limits a public site needs.

## Run it yourself

Requirements: Node.js 22 or later and an Anthropic API key.

```sh
npm install
echo "ANTHROPIC_API_KEY=your-key-here" > .env.local   # git-ignored; read by the dev server only
npm run dev                                           # http://localhost:5173
```

`npm run build` writes the static site to `dist/`. The model call lives in `api/read-chart.js`, a serverless
function; on Vercel it deploys as-is, with `ANTHROPIC_API_KEY` set as an environment variable. The fixed
instruction sent with every image is in `shared/runtime-prompt.js`.

The API route accepts JPEG images only, up to about 3 MB, from the same origin, with a per-address rate limit.
The key stays on the server.

## Licence

MIT. See [LICENSE](LICENSE).
