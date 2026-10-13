# Embroidered Memory

A small, dependency-free interactive website for stitching text into a photograph.

The experience is intentionally minimal:

1. Upload a photograph.
2. Click anywhere on the image.
3. Type.
4. While an IME is composing Korean text, the live text stays as a translucent white **ghost preview**.
5. Press **Space** or **Enter** to commit the current text.
6. The site samples the photograph underneath the text, derives a near-background thread color, and sews the letters onto the image with a procedural stitch animation.
7. Keyboard input is silently locked while the sewing animation is running.
8. Export the finished photo as PNG.

## Files

- `index.html` — page structure
- `style.css` — minimal interface and ghost preview styling
- `script.js` — image handling, IME logic, color sampling, procedural embroidery, animation, local save, export

No frameworks, npm packages, fonts, or external assets are required.

## Run locally

Because this project uses only static files, you can open `index.html` directly in most modern browsers.

For behavior closest to GitHub Pages, run a tiny local server from the project folder:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

## GitHub Pages deployment

### Option A — repository root

1. Create a new GitHub repository.
2. Upload these files to the repository root:
   - `index.html`
   - `style.css`
   - `script.js`
   - `README.md`
3. Commit and push.
4. In GitHub, open **Settings → Pages**.
5. Under **Build and deployment**, choose **Deploy from a branch**.
6. Select your main branch (usually `main`) and the folder `/ (root)`.
7. Save.
8. GitHub will publish the site at a URL similar to:

```text
https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/
```

### Option B — `docs/` folder

If you prefer, place the website files in `docs/` and select `/docs` in GitHub Pages settings.

## How the important interactions work

### 1. Background-matched embroidery color

Before a text object is sewn, the script samples pixels from the original photograph underneath the intended text bounding box.

The RGB samples are averaged in **linear-light RGB**, then converted to HSL. The resulting embroidery color stays very close to the sampled photograph but shifts lightness slightly so the thread remains visible. The actual stitches add a darker fiber shadow plus a thin lighter highlight strand.

This means readability comes mainly from **thread texture and raised volume**, rather than from a high-contrast text color.

### 2. Korean IME handling

The browser's native composition events are used:

- `compositionstart`
- `compositionupdate`
- `compositionend`
- `input`
- `keydown`

During composition, the browser's current input value is shown only as the white translucent ghost preview. A normal `compositionend` by itself does **not** commit embroidery.

**Space** or **Enter** commits the current buffer. The script also handles the browser/IME event order where that same first Space/Enter both ends Korean composition and acts as the user's commit trigger, so the user does not need to press the key twice.

### 3. Procedural embroidery

The final glyph is first rendered into an off-screen monochrome mask canvas. The script scans the mask into many short diagonal thread segments.

Each segment is drawn as:

- a soft dark fiber shadow,
- a colored thread core,
- a fine highlight strand,
- occasional stitch-hole marks.

The segments are revealed progressively with `requestAnimationFrame`, producing the sewing effect without any texture image asset.

### 4. Input lock

During the stitch animation:

- the hidden IME input is disabled,
- click placement is ignored,
- no warning or alert appears.

When stitching finishes, input is automatically re-enabled and focused again.

## Saving state

The latest image and text objects are saved to `localStorage`.

Large photographs can exceed a browser's local storage quota, so uploaded images are resized to a maximum edge of 1800 px and stored as compressed JPEG data for persistence. If the quota is still exceeded, the editor continues to work; only refresh persistence may be unavailable.

## Export

`Export PNG` redraws a clean final frame and exports the canvas as a PNG containing:

- the photograph
- all completed embroidery

The temporary ghost preview and UI are not included.

## Browser notes

Test in a recent version of Chrome, Edge, Firefox, or Safari. IME behavior can differ slightly by operating system, so Korean input should be tested on the actual target browser before exhibition or public deployment.
