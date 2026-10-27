"""
Exports the passes src/productPhoto/compose.ts makes every playlist's product
photo from, out of the approved scene (qrhit/studio/product-photo/
product-photo-v8.blend). The server never runs Blender: a playlist's photo is
this render with its own card pictures put onto the six card faces that show
one.

    /Applications/Blender.app/Contents/MacOS/Blender -b \
      ~/Sites/qrhit/studio/product-photo/product-photo-v8.blend \
      -P scripts/product-photo/export-passes.py -- --out assets/product-photo/scene-1

The .blend is not changed. Takes about three minutes on the Mac (Metal).

The format tiles (tile-cards, tile-sheets, tile-digital) are exported the same
way, at the size the server composes them:

    Blender -b ~/Sites/qrhit/studio/product-photo/tile-cards-v3.blend \
      -P scripts/product-photo/export-passes.py -- --out assets/product-photo/tile-cards --width 640

Which faces a scene has is read from the scene: every mesh with a `pp_role`
custom property, with `pp_side` (front or back) and `pp_card` (which of the
cards it shows), or `pp_page` for a page (the laptop's screen, a printed
sheet) whose picture the compositor lays out from card pictures
(src/productPhoto/pages.ts). The face material sits in the mesh's slot whose
material is called face_*, or in `pp_slot`. A scene without any (scene-1)
uses FACES below. A face picture may feed Base Color, Emission Color or both
(the screen glows); both are set white and black alike.

What it writes (float16 little endian, gzipped, rows top to bottom, colours
linear and premultiplied, as Cycles renders them):

- base.f16.gz: the render with the faces white (RGBA, full frame)
- face-<role>.f16.gz, over the face's bounding box, six channels:
  u*w, v*w, w (w: how much of the pixel that face covers, so u and v come out
  exact on its edges too) and the light on it, D = render(faces white) -
  render(faces black): the diffuse light without the gloss, which stays in
  the base. A playlist's photo is then base + (card - 1) * D per face.
- manifest.json: size, exposure, and per face its role, side, card or page,
  box and the picture size that matches its size on screen (texPx; a page
  has texW and texH, it is not square)
"""

import bpy
import gzip
import json
import math
import os
import sys
import time

import numpy as np

# role, object, material slot that faces the camera, which side of a card it shows
FACES = [
    ("hero", "hero", 0, "front"),
    ("answer", "answer", 1, "back"),
    ("deck", "deck_075", 0, "front"),
    ("fan", "fan_0", 0, "front"),
    ("songs", "songs_029", 1, "back"),
    ("song", "song_front", 1, "back"),
]
SAMPLES = 256
UV_SAMPLES = 64


def arg(name, default=None):
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return argv[argv.index(name) + 1] if name in argv else default


def render(path, samples, denoise):
    """Renders the camera view to a linear EXR and returns it as float32, top row first."""
    s = bpy.context.scene
    s.cycles.samples = samples
    s.cycles.use_denoising = denoise
    imf = s.render.image_settings
    imf.file_format = "OPEN_EXR"
    imf.color_depth = "32"
    imf.color_mode = "RGBA"
    t0 = time.time()
    bpy.ops.render.render(write_still=False)
    bpy.data.images["Render Result"].save_render(filepath=path)
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    os.remove(path)
    print(f"  rendered {os.path.basename(path)} in {time.time() - t0:.0f} s")
    return a.reshape(h, w, 4)[::-1].copy()


def face_materials():
    return [m for m in bpy.data.materials if m.name.startswith("face_") and m.use_nodes]


# per face material: the shader inputs its picture feeds, read before the first change
PICTURE_INPUTS = {}


def picture_inputs(m, bsdf, tex):
    if m.name not in PICTURE_INPUTS:
        fed = [link.to_socket.name for link in tex.outputs["Color"].links if link.to_node == bsdf]
        PICTURE_INPUTS[m.name] = fed or ["Base Color"]
    return PICTURE_INPUTS[m.name]


def set_albedo(value):
    """Every card face white (1), black (0), or back to its picture (None)."""
    for m in face_materials():
        nt = m.node_tree
        bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
        tex = next(n for n in nt.nodes if n.type == "TEX_IMAGE")
        for name in picture_inputs(m, bsdf, tex):
            socket = bsdf.inputs[name]
            for link in list(socket.links):
                nt.links.remove(link)
            if value is None:
                nt.links.new(tex.outputs["Color"], socket)
            else:
                socket.default_value = (value, value, value, 1.0)


def scene_faces():
    """The faces as the scene names them (pp_role and friends), else FACES."""
    found = []
    for o in sorted(bpy.context.scene.objects, key=lambda o: o.name):
        if o.type != "MESH" or "pp_role" not in o:
            continue
        slot = o.get("pp_slot")
        if slot is None:
            slot = next(i for i, sl in enumerate(o.material_slots) if sl.material and sl.material.name.startswith("face_"))
        page = o.get("pp_page")
        found.append(dict(role=o["pp_role"], name=o.name, slot=int(slot),
                          side="page" if page else o.get("pp_side", "front"),
                          card=None if page else int(o.get("pp_card", 0)), page=page))
    if found:
        return found
    return [dict(role=role, name=name, slot=slot, side=side, card=None, page=None) for role, name, slot, side in FACES]


def uv_material(uv_map):
    """Emits (u, v, 1): a render of it gives u*w, v*w, w per pixel."""
    m = bpy.data.materials.new("pp_uv")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = uv_map
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    comb = nt.nodes.new("ShaderNodeCombineXYZ")
    emit = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(uv.outputs[0], sep.inputs[0])
    nt.links.new(sep.outputs[0], comb.inputs[0])
    nt.links.new(sep.outputs[1], comb.inputs[1])
    comb.inputs[2].default_value = 1.0
    nt.links.new(comb.outputs[0], emit.inputs[0])
    emit.inputs[1].default_value = 1.0
    nt.links.new(emit.outputs[0], out.inputs[0])
    return m


def hole_material():
    m = bpy.data.materials.new("pp_hole")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    hole = nt.nodes.new("ShaderNodeHoldout")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(hole.outputs[0], out.inputs[0])
    return m


def tex_px(uvw):
    """The card picture size (px per side) that matches the face's size on screen."""
    w = uvw[..., 2]
    inner = w > 0.999
    u = np.where(inner, uvw[..., 0] / np.maximum(w, 1e-6), np.nan)
    v = np.where(inner, uvw[..., 1] / np.maximum(w, 1e-6), np.nan)
    gx = np.hypot(np.diff(u, axis=1)[:-1, :], np.diff(v, axis=1)[:-1, :])
    gy = np.hypot(np.diff(u, axis=0)[:, :-1], np.diff(v, axis=0)[:, :-1])
    # uv units per pixel along the least squeezed screen direction
    g = np.nanmedian(np.fmin(gx, gy))
    return int(math.ceil(1.0 / g / 16.0) * 16)


def page_px(uvw):
    """A page's picture size (width, height): screen pixels per unit of u and of v."""
    w = uvw[..., 2]
    inner = w > 0.999
    u = np.where(inner, uvw[..., 0] / np.maximum(w, 1e-6), np.nan)
    v = np.where(inner, uvw[..., 1] / np.maximum(w, 1e-6), np.nan)
    du = np.hypot(np.diff(u, axis=1)[:-1, :], np.diff(u, axis=0)[:, :-1])
    dv = np.hypot(np.diff(v, axis=1)[:-1, :], np.diff(v, axis=0)[:, :-1])
    return tuple(int(math.ceil(1.0 / np.nanmedian(g) / 16.0) * 16) for g in (du, dv))


def main():
    out = arg("--out")
    if not out:
        raise SystemExit("usage: ... -P export-passes.py -- --out <dir>")
    out = os.path.abspath(out)
    os.makedirs(out, exist_ok=True)
    s = bpy.context.scene
    # a background Blender renders on the CPU unless told otherwise
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for device in prefs.devices:
            device.use = True
        s.cycles.device = "GPU"
    except Exception as error:
        print(f"  no GPU ({error}), rendering on the CPU")
    s.render.resolution_percentage = 100
    s.render.film_transparent = True
    if arg("--width"):
        # the same framing at another size: the camera fits the width and keeps the aspect
        aspect = s.render.resolution_y / s.render.resolution_x
        s.render.resolution_x = int(arg("--width"))
        s.render.resolution_y = round(s.render.resolution_x * aspect)
    width, height = s.render.resolution_x, s.render.resolution_y
    tmp = os.path.join(out, "_render.exr")

    print(f"Base (faces white) and light (faces black), {width} x {height}")
    set_albedo(1.0)
    white = render(tmp, SAMPLES, True)
    set_albedo(0.0)
    black = render(tmp, SAMPLES, True)
    set_albedo(None)
    light = white[..., :3] - black[..., :3]

    with gzip.open(os.path.join(out, "base.f16.gz"), "wb", compresslevel=9) as f:
        f.write(white.astype("<f2").tobytes())

    meshes = [o for o in s.objects if o.type == "MESH"]
    holdout = {o.name: o.is_holdout for o in meshes}
    hole = hole_material()
    faces = []
    for spec in scene_faces():
        role, name, slot, side = spec["role"], spec["name"], spec["slot"], spec["side"]
        print(f"Face {role} ({name}, slot {slot})")
        target = bpy.data.objects[name]
        if target.data.users > 1:
            raise SystemExit(f"{name} shares its mesh; its materials cannot be swapped alone")
        face_mat = target.material_slots[slot].material
        uv_node = next(n for n in face_mat.node_tree.nodes if n.type == "UVMAP")
        uvm = uv_material(uv_node.uv_map)
        saved = [sl.material for sl in target.material_slots]
        for o in meshes:
            o.is_holdout = o is not target
        for i, sl in enumerate(target.material_slots):
            sl.material = uvm if i == slot else hole
        try:
            uvw = render(tmp, UV_SAMPLES, False)[..., :3]
        finally:
            for i, sl in enumerate(target.material_slots):
                sl.material = saved[i]
            for o in meshes:
                o.is_holdout = holdout[o.name]
            bpy.data.materials.remove(uvm)

        ys, xs = np.nonzero(uvw[..., 2] > 1e-3)
        x0, x1 = max(xs.min() - 2, 0), min(xs.max() + 3, width)
        y0, y1 = max(ys.min() - 2, 0), min(ys.max() + 3, height)
        box = np.concatenate([uvw[y0:y1, x0:x1], light[y0:y1, x0:x1]], axis=2)
        file = f"face-{role}.f16.gz"
        with gzip.open(os.path.join(out, file), "wb", compresslevel=9) as f:
            f.write(box.astype("<f2").tobytes())
        face = dict(role=role, side=side, file=file, box=[int(x0), int(y0), int(x1 - x0), int(y1 - y0)])
        if spec["page"]:
            tex_w, tex_h = page_px(uvw[y0:y1, x0:x1])
            face.update(page=spec["page"], texW=tex_w, texH=tex_h, texPx=max(tex_w, tex_h))
        else:
            face.update(texPx=tex_px(uvw[y0:y1, x0:x1]))
            if spec["card"] is not None:
                face.update(card=spec["card"])
        faces.append(face)
        print(f"  box {face['box']}, texPx {face['texPx']}{', page ' + face['page'] if spec['page'] else ''}")
    bpy.data.materials.remove(hole)

    manifest = dict(
        version=1,
        width=width,
        height=height,
        exposure=round(s.view_settings.exposure, 3),
        view=s.view_settings.view_transform,
        base="base.f16.gz",
        faces=faces,
        blend=os.path.basename(bpy.data.filepath),
        exported=time.strftime("%Y-%m-%d"),
    )
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"Wrote {len(faces) + 2} files to {out}")


main()
