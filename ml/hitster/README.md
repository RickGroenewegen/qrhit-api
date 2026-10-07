# Hitster detector

A small model that finds Hitster material in a picture a customer puts on a
card or box: the word "Hitster" in any lettering (near-spellings such as
"Hitser" and "Hitstor" included), the rings from the back of a Hitster card,
the chrome speaker and the "THE MUSIC CARD GAME" pill from the box. Built to
replace the GPT vision call of the designer's Hitster screen with something
that answers in a tenth of a second and costs nothing per picture.

Only code lives here in git. Customer uploads, Hitster pictures, fonts,
renders and weights stay in `data/` and `runs/` on the machine that made
them (`.gitignore`).

## The model

MobileNetV3-Large (torchvision, ImageNet weights, BSD) to stride 32, merged
top-down into stride 16, and a head that scores every 16x16 cell per class
(`model.py`). No boxes are regressed: the cells that light up show where the
mark is, the highest cell per class is the verdict. 3.1 M parameters, about
12 MB as float32 ONNX, about 3 MB as int8.

Input is the picture flattened and letterboxed to 512 x 512 exactly as
`preprocess.py` says; anything that runs the model (API, browser) has to do
the same, including putting transparency on a contrasting grey (a white logo
on transparent must not be flattened onto white).

## Data

| what | where | how |
|---|---|---|
| every card and box upload on Print&Bind order lines (negatives, and the pool of backgrounds) | `data/prod/` | `order_lines.tsv` / `extra_designs.tsv` exported with `_scripts/ro-query.sh --batch` (see `fetch_uploads.py`), then `fetch_uploads.py` |
| fonts for drawing the word | `data/fonts/` | `fetch_fonts.py` (Google Fonts, OFL) and `fonts.py` (adds this Mac's fonts, splits families 85/15 into train/eval) |
| public Hitster pictures, look-alikes | `data/web/` | a URL list from a read-only research pass, then `fetch_web.py` |
| labels | `data/labels/` | `positives_rick.txt` (Rick), `positives.txt` / `negatives.txt` (reviewed), `weak_web.txt` (web pictures that show a mark), `web_excluded.txt` |

Uploads are deduplicated by the md5 of the original file (a preset picked in
the designer is stored under a new random name). 10% of them, by md5, never
train: they are the held-out negatives of the real evaluation. Pictures on an
order line that has a labelled positive are kept out of both until reviewed.

Training samples (`synth.py`) are drawn on the fly: a background (an upload,
a preset, a plain fill) with the word, rings or reference cut-outs from
`marks.py` placed on it, look-alikes beside them ("HIPSTER", "TWISTER",
single-colour rings, vinyl, targets), photo-like damage (JPEG, blur, noise),
then the same letterbox as inference. Cells inside a mark are 1, its rim is
ignored, everything else is 0. Web pictures train without boxes: only "there
is something here" is known.

## Commands

All with `env -u PYTHONPATH uv run python …` (the shell's PYTHONPATH points
at Python 3.13 packages and breaks this 3.12 environment).

    uv sync                                  # packages, at least 7 days old (exclude-newer)
    python fetch_uploads.py                  # after the two ro-query exports
    python fetch_fonts.py && python fonts.py
    python fetch_web.py urls.jsonl
    python train.py --name v1 --steps 8000 --weak data/labels/weak_web.txt
    python score.py runs/v1/last.pt          # ranks every upload, sheets in data/review/v1/
    python export.py runs/v1/last.pt         # hitster.onnx, hitster.int8.onnx, timings

Training on an M2 Pro with 16 GB: batch 16 at 512 px, about 35 pictures a
second. Set `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.6 PYTORCH_MPS_LOW_WATERMARK_RATIO=0.5`
and keep the data workers at 6: with 24 per batch and 9 workers the machine
went 16 GB into swap.

## Looking, labelling, retraining

`cd node && npx tsx server.ts` serves two local pages on
http://localhost:5197, on the same TypeScript code the API runs:

- `/` takes dropped, picked or pasted pictures and shows the verdict, the
  score per mark and the cells that lit up.
- `/browse` steps through every downloaded upload (arrow keys), with the
  scores `score.py` wrote for the chosen model and the label it has. **H** /
  **N** label a picture Hitster / not Hitster and go to the next, **C**
  clears. Those verdicts go to `data/labels/labels_ui.txt` (last line per
  picture wins) and beat every other label at the next training.

Labelling is worth it where the model is unsure or wrong: "not labelled",
highest score first, until a long run is clean; then "disagreements".

`python retrain.py --from v3 --name v4` takes new labels in: it continues
training from the named model (1500 steps, about 15 minutes; `--steps 6000`
for a full run), exports it and scores every upload, after which the new
model is in the pages' model menu. One training at a time.

Compare a new model with the shipped one on the same test set before
copying it to `assets/hitster/hitster.onnx` (v2 lost the rings and was not
shipped). v3, shipped 2026-10-07, on 93 test positives and 541 clean test
pictures at 0.5: 88 caught (95%, every ring card back and all 14 of Rick's
examples), 5 wrongly flagged (0.9%).

## Rick's rules (2026-10-06)

Hitster: the word in any lettering and near-spellings (HITSER, Hitstor,
HITSTAR), the rings, the speaker and the pill on their own. Not Hitster:
JITSTER, a name or word with "-ster" (Brittster, Swiftster, Sipster,
Shipster), HITSPEL. `marks.py` draws them that way.
