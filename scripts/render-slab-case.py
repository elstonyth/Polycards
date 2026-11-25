# The graded slab's case (owner 2026-11-24: "use the correct material and the
# correct texture on our slab ... the old one we just randomly generated").
# Modelled as the real thing: one closed solid of clear moulded plastic, seen
# straight down. A genuine PSA holder is clear; cloudy edges are a tamper sign.
# The rim, the frames round the label and the card, and the weld line between
# them follow PSA's own product photo by eye. The model is about 5.9 mm thick
# at the rim; a real holder calipers at about 6.25 mm, and that is the depth the
# page turns it with (CASE_DEPTH in SlabCard.tsx). Seen straight down the
# difference does not show, so the faces were not rendered again.
#
# What must not move (backend bake-slab.ts puts the card and the label text by
# these): the 1600x2700 canvas, the label sticker's box, the card window.
#
# The solid is a height field with a flat back. Its top and back meet at every
# edge (outline and card window) through a rounded profile, so it is watertight
# without boolean cuts.
#
# Rendered twice, over a black and a white page with the same seed, so
# scripts/compose-slab-case.mjs can work out how see-through each pixel is.
#
#   blender -b --factory-startup -P scripts/render-slab-case.py -- \
#     [--scale 1] [--samples 128]
#     -> docs/research/slab-case/black.png, white.png   (about 8 minutes)
#   blender -b --factory-startup -P scripts/render-slab-case.py -- --edge
#     -> docs/research/slab-case/edge-v.png   (the case's long edge, edge-on)
#
# 1 px = 0.01 Blender units. CPU on purpose (a GPU render crashed this PC once).
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

U = 0.01
W, H = 1600, 2700
CELL = 2  # px per grid cell of the model
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "research", "slab-case")

# The contract, in px.
LABEL = (117, 113, 1489, 514)
# The card well. bake-slab.ts fits the card to x 183-1417 from y 739; a 5:7 card
# ends at 2468. The well runs on to 2500 so a taller scan (down to about 0.70
# wide per high) still clears the plastic's edge.
WIN = (174, 730, 1426, 2500)

SHAPE = dict(
    outline=(8, 8, 1592, 2692),
    outline_r=60,
    window_r=14,
    half=50,  # half the case's thickness
    edge=26,  # radius of the rounded edges
    lip=14,  # the raised rim round the face
    lip_w=56,
    ridge=13,  # the moulded frames round the label and the card
    groove=8,  # the weld line between the label and the card
    groove_y=612,
)

LOOK = dict(
    ior=1.5,
    roughness=0.03,
    key=15.0,  # soft box, top left
    side=7.0,  # weaker box, right
    low=6.0,  # weaker box, bottom
    sheen=1.0,  # soft light overhead: the faint gloss on the top-left faces
)


def arg(name, default):
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return argv[argv.index(name) + 1] if name in argv else default


def sd_rrect(X, Y, box, r):
    """Signed distance to a rounded rectangle, negative inside."""
    x0, y0, x1, y1 = box
    qx = np.abs(X - (x0 + x1) / 2) - ((x1 - x0) / 2 - r)
    qy = np.abs(Y - (y0 + y1) / 2) - ((y1 - y0) / 2 - r)
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def grow(box, by):
    return (box[0] - by, box[1] - by, box[2] + by, box[3] + by)


def case_mesh():
    S = SHAPE
    xs = np.linspace(0, W, W // CELL + 1)
    ys = np.linspace(0, H, H // CELL + 1)
    X, Y = np.meshgrid(xs, ys)
    d_out = -sd_rrect(X, Y, S["outline"], S["outline_r"])  # + inside the case
    d_win = sd_rrect(X, Y, WIN, S["window_r"])  # + outside the card well
    d = np.minimum(d_out, d_win)
    inside = d > 0

    lip = S["lip"] * (1 - sstep(S["lip_w"] - 11, S["lip_w"] + 11, d_out))
    label_frame = S["ridge"] * (1 - sstep(3, 17, np.abs(sd_rrect(X, Y, grow(LABEL, 26), 20))))
    card_frame = S["ridge"] * (1 - sstep(3, 17, np.abs(sd_rrect(X, Y, grow(WIN, 50), 36))))
    groove = S["groove"] * (1 - sstep(2, 13, np.abs(Y - S["groove_y"]))) * sstep(S["lip_w"] + 11, S["lip_w"] + 24, d_out)
    relief = np.maximum(np.maximum(lip, label_frame), card_frame) - groove

    t = np.clip(d / S["edge"], 0, 1)
    edge = np.sqrt(np.clip(1 - (1 - t) ** 2, 0, 1))
    z_top = edge * (S["half"] + relief)
    z_bot = -edge * S["half"]

    cell = inside[:-1, :-1] | inside[:-1, 1:] | inside[1:, :-1] | inside[1:, 1:]
    used = np.zeros_like(inside)
    used[:-1, :-1] |= cell
    used[:-1, 1:] |= cell
    used[1:, :-1] |= cell
    used[1:, 1:] |= cell
    top_id = np.full(inside.shape, -1, dtype=np.int64)
    n_top = int(used.sum())
    top_id[used] = np.arange(n_top)
    # Vertices on or past an edge sit at z=0 and are shared by top and back.
    own_back = used & inside
    bot_id = top_id.copy()
    bot_id[own_back] = n_top + np.arange(int(own_back.sum()))

    xb = (X - W / 2) * U
    yb = (H / 2 - Y) * U
    co = np.zeros((n_top + int(own_back.sum()), 3))
    co[top_id[used]] = np.stack([xb, yb, np.where(inside, z_top, 0) * U], axis=-1)[used]
    co[bot_id[own_back]] = np.stack([xb, yb, z_bot * U], axis=-1)[own_back]

    ci, cj = np.nonzero(cell)
    quad = lambda ids, order: np.stack(
        [ids[ci + di, cj + dj] for di, dj in order], axis=-1
    )
    top = quad(top_id, [(0, 0), (1, 0), (1, 1), (0, 1)])  # anticlockwise from above
    back = quad(bot_id, [(0, 0), (0, 1), (1, 1), (1, 0)])
    faces = np.concatenate([top, back])

    mesh = bpy.data.meshes.new("case")
    mesh.from_pydata(co.tolist(), [], faces.tolist())
    mesh.update()
    mesh.shade_smooth()

    # Clear plastic renders black if the solid is open or inside out.
    bm = bmesh.new()
    bm.from_mesh(mesh)
    open_edges = sum(1 for e in bm.edges if not e.is_manifold)
    volume = bm.calc_volume(signed=True)
    bm.free()
    print(f"CASE verts {len(co)} faces {len(faces)} open-edges {open_edges} volume {volume:.2f}")
    assert open_edges == 0, "the case is not a closed solid"
    assert volume > 0, "the case is inside out"
    return mesh


def emission(name, strength_setup=None, strength=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Strength"].default_value = strength
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    if strength_setup:
        strength_setup(nt, em)
    return mat


def panel(name, location, size, mat, aim=True):
    bpy.ops.mesh.primitive_plane_add(size=1, location=location)
    ob = bpy.context.object
    ob.name = name
    ob.scale = (size[0], size[1], 1)
    if aim:
        ob.rotation_euler = (-Vector(location)).to_track_quat("-Z", "Y").to_euler()
    ob.data.materials.append(mat)
    ob.visible_camera = False
    return ob


def build():
    scene = bpy.context.scene
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)

    case = bpy.data.objects.new("case", case_mesh())
    scene.collection.objects.link(case)
    mat = bpy.data.materials.new("plastic")
    mat.use_nodes = True
    b = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (1, 1, 1, 1)
    b.inputs["Transmission Weight"].default_value = 1.0
    b.inputs["IOR"].default_value = LOOK["ior"]
    b.inputs["Roughness"].default_value = LOOK["roughness"]
    case.data.materials.append(mat)

    # The camera looks straight down, so a flat face mirrors whatever is right
    # above it. The boxes stand off to the sides: flat faces stay clear and only
    # the rounded edges catch them.
    panel("key", (-26, 30, 24), (26, 44), emission("key", strength=LOOK["key"]))
    panel("side", (26, -4, 20), (20, 40), emission("side", strength=LOOK["side"]))
    panel("low", (-4, -38, 18), (36, 16), emission("low", strength=LOOK["low"]))

    def fade(nt, em):
        # Brightest over the top left, gone by the middle.
        tc = nt.nodes.new("ShaderNodeTexCoord")
        sep = nt.nodes.new("ShaderNodeSeparateXYZ")
        mix = nt.nodes.new("ShaderNodeMath")
        mix.operation = "SUBTRACT"
        ramp = nt.nodes.new("ShaderNodeMapRange")
        ramp.inputs["From Min"].default_value = 0.0
        ramp.inputs["From Max"].default_value = 0.5
        ramp.inputs["To Min"].default_value = 0.0
        ramp.inputs["To Max"].default_value = LOOK["sheen"]
        nt.links.new(tc.outputs["Generated"], sep.inputs["Vector"])
        nt.links.new(sep.outputs["Y"], mix.inputs[0])
        nt.links.new(sep.outputs["X"], mix.inputs[1])
        nt.links.new(mix.outputs["Value"], ramp.inputs["Value"])
        nt.links.new(ramp.outputs["Result"], em.inputs["Strength"])

    panel("sheen", (0, 0, 40), (40, 50), emission("sheen", fade), aim=False)

    # The page under the case: black for one pass, white for the other.
    page = panel("page", (0, 0, -(SHAPE["half"] + 8) * U), (80, 120), emission("page", strength=0.0), aim=False)
    page.visible_camera = True

    world = scene.world or bpy.data.worlds.new("world")
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0, 0, 0, 1)
    scene.world = world

    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = H * U
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (0, 0, 60)
    scene.camera = cam


def configure(scale, samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.seed = 7
    scene.cycles.use_animated_seed = False
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 16
    scene.cycles.transmission_bounces = 16
    scene.cycles.glossy_bounces = 8
    scene.render.use_persistent_data = True
    scene.render.resolution_x = round(W * scale)
    scene.render.resolution_y = round(H * scale)
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    try:
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
    except TypeError as err:
        print("view transform not set:", err)
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"


EDGE_PX = 160  # an edge strip's width: the case is about 115px deep, plus room


def render_edge(scale):
    """The case stood on its long side under the same lights, seen square-on
    over black. The pack reveal turns the slab in 3D and needs something to
    show between the two faces."""
    scene = bpy.context.scene
    bpy.data.objects["case"].rotation_euler = (0, math.pi / 2, 0)
    bpy.data.objects["page"].location.z = -H * U  # clear of the upended case
    scene.render.resolution_x = round(EDGE_PX * scale)
    scene.render.resolution_y = round(H * scale)
    out = os.path.abspath(os.path.join(OUT, "edge-v.png"))
    scene.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print("WROTE", out)


if __name__ == "__main__":
    scale = float(arg("--scale", "1"))
    edge = "--edge" in sys.argv
    build()
    configure(scale, int(arg("--samples", "128")))
    os.makedirs(OUT, exist_ok=True)
    nodes = bpy.data.materials["page"].node_tree.nodes
    page_light = next(n for n in nodes if n.type == "EMISSION")
    if edge:
        render_edge(scale)
        sys.exit(0)
    for name, level in (("black", 0.0), ("white", 1.0)):
        page_light.inputs["Strength"].default_value = level
        out = os.path.abspath(os.path.join(OUT, f"{name}.png"))
        bpy.context.scene.render.filepath = out
        bpy.ops.render.render(write_still=True)
        print("WROTE", out)
