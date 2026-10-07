"""
How a picture becomes model input, the same in training, scoring and (ported
1:1 to TypeScript) in the browser and the Lambda:

1. EXIF orientation applied.
2. Transparency flattened onto a plain colour that contrasts with what is
   drawn: dark grey under light artwork, light grey under dark artwork. A
   white logo on transparent would vanish on white.
3. Letterboxed: scaled so the long side is SIZE, centred on a SIZE x SIZE
   canvas of PAD.
4. RGB scaled to 0..1 and normalised with the ImageNet mean and std
   (the backbone was pretrained that way).
"""

import numpy as np
from PIL import Image, ImageOps

SIZE = 512
STRIDE = 16
PAD = (114, 114, 114)
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
DARK_UNDER = (32, 32, 32)
LIGHT_UNDER = (235, 235, 235)


def flatten(image: Image.Image) -> Image.Image:
    """RGB, with any transparency put on a contrasting plain colour."""
    if image.mode not in ("RGBA", "LA", "PA", "P"):
        return image.convert("RGB")
    rgba = image.convert("RGBA")
    pixels = np.asarray(rgba)
    alpha = pixels[..., 3]
    if alpha.min() == 255:
        return rgba.convert("RGB")
    drawn = alpha > 128
    if drawn.any():
        lum = (0.299 * pixels[..., 0] + 0.587 * pixels[..., 1] + 0.114 * pixels[..., 2])[drawn].mean()
    else:
        lum = 0
    under = DARK_UNDER if lum > 140 else LIGHT_UNDER
    base = Image.new("RGBA", rgba.size, under + (255,))
    base.alpha_composite(rgba)
    return base.convert("RGB")


def letterbox(image: Image.Image, size: int = SIZE, pad=PAD):
    """(canvas, scale, offset_x, offset_y)."""
    w, h = image.size
    scale = size / max(w, h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    resized = image.resize((nw, nh), Image.BILINEAR)
    canvas = Image.new("RGB", (size, size), pad)
    ox, oy = (size - nw) // 2, (size - nh) // 2
    canvas.paste(resized, (ox, oy))
    return canvas, scale, ox, oy


def to_tensor_array(image: Image.Image) -> np.ndarray:
    """(3, H, W) float32, normalised."""
    array = np.asarray(image, np.float32) / 255.0
    array = (array - MEAN) / STD
    return array.transpose(2, 0, 1).copy()


def load(path, size: int = SIZE):
    image = Image.open(path)
    image = ImageOps.exif_transpose(image)
    flat = flatten(image)
    canvas, *_ = letterbox(flat, size)
    return to_tensor_array(canvas)
