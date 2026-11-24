# Build and render the glass tier frames (the band around a card that shows its
# rarity) in Blender. One coloured-glass bar per tier over a satin metal bed,
# with the same lights for every tier, so only the colour differs. Each tier is
# rendered twice: the still frame, and a "lit" state the storefront uses to make
# a light travel round the glass (see set_state). Writes opaque PNGs;
# scripts/compose-glass-tier-frames.mjs cuts them to the exact band shape and
# writes the shipped webps.
#
# In an open Blender (to watch it): run this file in the Text Editor, or exec it
# and call clear_scene() / build_scene(kind, tier) / render_all(out_dir).
# Unattended:
#   blender -b --factory-startup -P scripts/render-glass-tier-frames.py -- \
#     [--out docs/research/glass-frames] [--scale 1] [--samples 192]
#     [--frame lucky-draw]   a prize frame instead of the six tiers (PRIZES);
#                            the shipped one was rendered with --samples 64
#
# Geometry is 1:1 with src/components/SlabImage.tsx: 1 px = 0.01 Blender units.
# CPU on purpose: a GPU render crashed this PC's session once (2026-11-21).
import math
import os
import sys

import bmesh
import bpy

U = 0.01  # Blender units per pixel

# src/lib/rarity.ts RARITY_RGB, keyed by the frame filename.
TIERS = {
    "immortal": (251, 146, 60),
    "legendary": (236, 72, 153),
    "mythical": (168, 85, 247),
    "rare": (37, 99, 235),
    "uncommon": (56, 189, 248),
    "common": (163, 163, 163),
}

# Band boxes in px: outer size, outer radius, band width, hole radius.
KINDS = {
    "slab": dict(w=1600, h=2590, outer_r=147, inset=79, hole_r=55),
    "raw": dict(w=1240, h=1685, outer_r=117, inset=64, hole_r=53),
}

# The look, in one place. Lengths are fractions of the band width.
LOOK = dict(
    thickness=0.40,  # glass depth
    wall=0.04,  # straight side before the rounded edge starts
    bevel=0.5,  # width of the rounded edge; 0.5 = a fully rounded glass rod
    tint_white=0.0,  # lifts the tier colour if a dark tier goes murky
    roughness=0.035,
    wave=0.12,  # strength of the slow surface waviness
    bed_grey=0.5,
    bed_roughness=0.22,
    line_gap=0.14,  # space between the bed's two engraved lines
    line_width=0.05,  # width of each line
    line_depth=0.7,  # how much darker a line is than the bed
    bed_glow=0.03,  # tier-coloured light from the bed, so no side goes dead
    light=1.0,  # one dial for every softbox
)


def srgb_to_linear(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def tier_linear(tier, mix_white=0.0):
    lin = [srgb_to_linear(c) for c in TIERS[tier]]
    return tuple(v + (1 - v) * mix_white for v in lin) + (1.0,)


def absorption(target, path):
    """Volume Absorption colour and density that turn white light into exactly
    `target` (linear RGB) after `path` units of glass (Cycles absorbs at
    density * (1 - colour) per unit). Thinner glass comes out paler."""
    target = [max(c, 0.02) for c in target[:3]]
    sigma = [-math.log(c) / path for c in target]
    density = max(max(sigma) / 0.98, 1e-6)
    return tuple(1 - s / density for s in sigma) + (1.0,), density


def rounded_rect(w, h, r, seg):
    """Points of a rounded rect centred on the origin, counter-clockwise."""
    pts = []
    for k, (sx, sy) in enumerate([(1, 1), (-1, 1), (-1, -1), (1, -1)]):
        cx, cy = sx * (w / 2 - r), sy * (h / 2 - r)
        for i in range(seg + 1):
            a = math.radians(90 * k + 90 * i / seg)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def band_loops(kind, seg=64):
    g = KINDS[kind]
    outer = rounded_rect(g["w"], g["h"], g["outer_r"], seg)
    inner = rounded_rect(
        g["w"] - 2 * g["inset"], g["h"] - 2 * g["inset"], g["hole_r"], seg
    )
    return outer, inner


def profile(steps=18):
    """Cross-section from the outer edge to the inner one: (t, height) pairs,
    both as fractions (t of the band width, height of the glass thickness)."""
    wall = LOOK["wall"] / LOOK["thickness"]
    half = [(0.0, 0.0), (0.0, wall)]
    for i in range(1, steps + 1):
        x = i / steps
        half.append((LOOK["bevel"] * x, wall + (1 - wall) * math.sin(x * math.pi / 2)))
    mirror = [(1 - t, z) for t, z in reversed(half)]
    # A fully rounded rod meets itself at the crest: keep that row once.
    return half + (mirror[1:] if mirror[0][0] == half[-1][0] else mirror)


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def make_bar(kind):
    """The glass bar: flat top, rounded polished edges, flat underneath."""
    outer, inner = band_loops(kind)
    n = len(outer)
    thick = KINDS[kind]["inset"] * LOOK["thickness"] * U
    bm = bmesh.new()
    rows = [
        [
            bm.verts.new(
                ((o[0] + (i[0] - o[0]) * t) * U, (o[1] + (i[1] - o[1]) * t) * U, z * thick)
            )
            for o, i in zip(outer, inner)
        ]
        for t, z in profile()
    ]
    for j in range(len(rows) - 1):
        for k in range(n):
            k2 = (k + 1) % n
            bm.faces.new((rows[j][k], rows[j][k2], rows[j + 1][k2], rows[j + 1][k]))
    # Underside on its own verts, so the rim's smooth normals stay sideways.
    bo = [bm.verts.new((p[0] * U, p[1] * U, 0)) for p in outer]
    bi = [bm.verts.new((p[0] * U, p[1] * U, 0)) for p in inner]
    for k in range(n):
        k2 = (k + 1) % n
        bm.faces.new((bo[k], bi[k], bi[k2], bo[k2]))
    for f in bm.faces:
        f.smooth = True
    bm.normal_update()
    mesh = bpy.data.meshes.new("glass-bar")
    bm.to_mesh(mesh)
    bm.free()
    return link(bpy.data.objects.new("glass-bar", mesh))


def make_bed(kind):
    """The satin metal bed the glass sits on, cut to the band. UV.x runs 0..1
    across the band (outer edge to inner), which is what its engraved lines
    are drawn against, so they follow the frame round every corner."""
    outer, inner = band_loops(kind)
    n = len(outer)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    vo = [bm.verts.new((p[0] * U, p[1] * U, -U)) for p in outer]
    vi = [bm.verts.new((p[0] * U, p[1] * U, -U)) for p in inner]
    for k in range(n):
        k2 = (k + 1) % n
        face = bm.faces.new((vo[k], vo[k2], vi[k2], vi[k]))
        for loop, u in zip(face.loops, (0, 0, 1, 1)):
            loop[uv].uv = (u, 0)
    bm.normal_update()
    mesh = bpy.data.meshes.new("bed")
    bm.to_mesh(mesh)
    bm.free()
    return link(bpy.data.objects.new("bed", mesh))


def quad(name, size, z=0.0):
    sx, sy = size[0] / 2, size[1] / 2
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(
        [(-sx, -sy, z), (sx, -sy, z), (sx, sy, z), (-sx, sy, z)], [], [(0, 1, 2, 3)]
    )
    return link(bpy.data.objects.new(name, mesh))


def principled(mat):
    mat.use_nodes = True
    return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")


def glass_material():
    mat = bpy.data.materials.new("glass")
    b = principled(mat)
    nt = mat.node_tree
    b.inputs["Base Color"].default_value = (1, 1, 1, 1)
    b.inputs["Transmission Weight"].default_value = 1.0
    b.inputs["Roughness"].default_value = LOOK["roughness"]
    b.inputs["IOR"].default_value = 1.5
    # The colour lives in the glass, not on it: thick parts go deeper.
    absorb = nt.nodes.new("ShaderNodeVolumeAbsorption")
    absorb.name = "tier-absorb"
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    nt.links.new(absorb.outputs["Volume"], out.inputs["Volume"])
    # Slow surface waviness: real glass is never optically flat.
    coord = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 0.5
    noise.inputs["Detail"].default_value = 2.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = LOOK["wave"]
    bump.inputs["Distance"].default_value = 0.02
    nt.links.new(coord.outputs["Object"], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Factor"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    return mat


def bed_material():
    """Satin metal with two hair-thin lines engraved along the band, one each
    side of its middle (operator, 2026-11-23: "lines along the frame"; fine
    cross-ribs were tried first and refused). The glass above stays smooth; the
    lines are seen through it. Shade only, no relief."""
    mat = bpy.data.materials.new("bed")
    b = principled(mat)
    nt = mat.node_tree
    b.inputs["Metallic"].default_value = 1.0
    b.inputs["Roughness"].default_value = LOOK["bed_roughness"]
    b.inputs["Emission Strength"].default_value = LOOK["bed_glow"]

    def math_node(operation, value):
        n = nt.nodes.new("ShaderNodeMath")
        n.operation = operation
        n.inputs[1].default_value = value
        return n

    uv = nt.nodes.new("ShaderNodeUVMap")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    # Distance of a point from the nearer line: | |u - 0.5| - gap / 2 |.
    chain = [
        math_node("SUBTRACT", 0.5),
        math_node("ABSOLUTE", 0.0),
        math_node("SUBTRACT", LOOK["line_gap"] / 2),
        math_node("ABSOLUTE", 0.0),
    ]
    chain[2].name = "line-gap"
    shade = nt.nodes.new("ShaderNodeMapRange")  # line grey .. bed grey
    shade.name = "line-shade"
    shade.interpolation_type = "SMOOTHSTEP"
    shade.inputs["From Min"].default_value = 0.0
    shade.inputs["From Max"].default_value = LOOK["line_width"] / 2
    shade.inputs["To Min"].default_value = LOOK["bed_grey"] * (1 - LOOK["line_depth"])
    shade.inputs["To Max"].default_value = LOOK["bed_grey"]
    nt.links.new(uv.outputs["UV"], sep.inputs[0])
    out = sep.outputs["X"]
    for n in chain:
        nt.links.new(out, n.inputs[0])
        out = n.outputs[0]
    nt.links.new(out, shade.inputs["Value"])
    nt.links.new(shade.outputs["Result"], b.inputs["Base Color"])
    return mat


def emission_material(name, strength, colour=(1, 1, 1)):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = colour + (1,)
    em.inputs["Strength"].default_value = strength
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return mat


def softbox(name, size, location, strength, colour=(1, 1, 1), lights="glass"):
    """An emissive card, hidden from the camera itself. `lights="glass"` cards
    show only as reflections on the glass surface (the crisp highlights);
    `lights="bed"` cards are seen only through the glass, by the bed (the body
    colour). Keeping the two apart lets each be set without washing the other."""
    ob = quad(name, size)
    ob.location = location
    ob.rotation_euler = (-ob.location).to_track_quat("-Z", "Y").to_euler()
    ob.data.materials.append(
        emission_material(name, strength * LOOK["light"], colour)
    )
    ob.visible_camera = False
    ob.visible_diffuse = False
    ob.visible_glossy = lights == "glass"
    ob.visible_transmission = lights == "bed"
    ob["state"] = "lit" if name.startswith("lit-") else "base"
    return ob


def set_state(state):
    """Switch the studio. "base" is the still frame. "lit" adds a light right
    over every part of the same glass; the storefront shows that state through
    a slowly turning wedge, so one light seems to travel round the frame."""
    for ob in bpy.data.objects:
        if ob.get("state") == "lit":
            ob.hide_render = ob.hide_viewport = state != "lit"


def set_tier(tier):
    """Recolour the scene for one tier; nothing else changes between tiers."""
    # Light crosses the flat part of the glass twice: down to the bed and back.
    depth = bpy.data.objects["glass-bar"].dimensions.z
    colour, density = absorption(tier_linear(tier, LOOK["tint_white"]), 2 * depth)
    glass = bpy.data.materials["glass"].node_tree.nodes["tier-absorb"]
    glass.inputs["Color"].default_value = colour
    glass.inputs["Density"].default_value = density
    principled(bpy.data.materials["bed"]).inputs[
        "Emission Color"
    ].default_value = tier_linear(tier)


# The Lucky Draw prize frame, "Black lacquer" (owner, 2026-11-24, picked from
# test renders): near-black glossy glass over a black bed, with ONE thin line
# of lilac light down the middle of the band. Not a tier: it marks a prize.
LUCKY_DRAW = dict(
    glass=(0.05, 0.05, 0.06),
    bed=(0.03, 0.03, 0.035, 1),
    line=(0.82, 0.76, 1.0, 1),
    line_width=0.07,
    line_glow=9.0,
)


def lucky_draw_look():
    """Turn a freshly built scene into the Lucky Draw frame. It rewires the
    bed, so never recolour the result with set_tier: build a new scene."""
    depth = bpy.data.objects["glass-bar"].dimensions.z
    colour, density = absorption(LUCKY_DRAW["glass"], 2 * depth)
    glass = bpy.data.materials["glass"].node_tree.nodes["tier-absorb"]
    glass.inputs["Color"].default_value = colour
    glass.inputs["Density"].default_value = density

    bed = bpy.data.materials["bed"]
    nt = bed.node_tree
    b = principled(bed)
    nt.nodes["line-gap"].inputs[1].default_value = 0.0  # two lines become one
    shade = nt.nodes["line-shade"]  # now a mask: 0 on the line .. 1 on the bed
    shade.inputs["From Max"].default_value = LUCKY_DRAW["line_width"] / 2
    shade.inputs["To Min"].default_value = 0.0
    shade.inputs["To Max"].default_value = 1.0

    def socket(sockets, identifier):
        return next(s for s in sockets if s.identifier == identifier)

    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    nt.links.new(shade.outputs["Result"], socket(mix.inputs, "Factor_Float"))
    socket(mix.inputs, "A_Color").default_value = LUCKY_DRAW["line"]
    socket(mix.inputs, "B_Color").default_value = LUCKY_DRAW["bed"]
    colour_out = socket(mix.outputs, "Result_Color")
    nt.links.new(colour_out, b.inputs["Base Color"])
    nt.links.new(colour_out, b.inputs["Emission Color"])
    # Only the line gives off light.
    line = nt.nodes.new("ShaderNodeMath")
    line.operation = "SUBTRACT"
    line.inputs[0].default_value = 1.0
    nt.links.new(shade.outputs["Result"], line.inputs[1])
    glow = nt.nodes.new("ShaderNodeMath")
    glow.operation = "MULTIPLY"
    nt.links.new(line.outputs[0], glow.inputs[0])
    glow.inputs[1].default_value = LUCKY_DRAW["line_glow"]
    nt.links.new(glow.outputs[0], b.inputs["Emission Strength"])


# Frames that are not tiers, by the filename they ship under.
PRIZES = {"lucky-draw": lucky_draw_look}


def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for blocks in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for block in list(blocks):
            blocks.remove(block)


def build_scene(kind, tier="legendary"):
    scene = bpy.context.scene
    g = KINDS[kind]

    bar = make_bar(kind)
    bar.data.materials.append(glass_material())
    bar.visible_shadow = False  # let the softboxes light the bed directly

    make_bed(kind).data.materials.append(bed_material())

    # Same studio for every tier and both kinds, sized off the slab frame.
    # A card's long side is its local X, which stays level when it turns to
    # face the frame, so a strip beside a bar runs along that bar.
    softbox("key", (16, 11), (-10, 15, 17), 13.0)
    softbox("fill", (26, 4), (15, -5, 9), 9.0)
    softbox("kick", (22, 3), (2, -21, 6), 12.0, (1.0, 0.95, 0.9))
    softbox("bed-base", (30, 44), (0, 0, 34), 0.8, lights="bed")
    softbox("bed-key", (14, 14), (-9, 14, 14), 3.0, lights="bed")
    # The extra "lit" light: a box close above the whole frame (a broad white
    # reflection across the rod) and much more light on the bed, so the glass
    # goes white-hot with the tier colour left on its edges. Softer versions
    # (crest at z=42, bed 5.0) read as "the same" to the owner at 420px.
    softbox("lit-crest", (17, 27), (0, 0, 16), 30.0)
    softbox("lit-bed", (30, 44), (0, 0, 33), 9.0, lights="bed")
    set_state("base")

    world = scene.world or bpy.data.worlds.new("world")
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0.003, 0.003, 0.004, 1)
    scene.world = world

    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = max(g["w"], g["h"]) * U
    cam = link(bpy.data.objects.new("cam", cam_data))
    cam.location = (0, 0, 50)
    scene.camera = cam

    set_tier(tier)
    configure_render(kind)


def configure_render(kind, scale=1.0, samples=192):
    scene = bpy.context.scene
    g = KINDS[kind]
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 12
    scene.cycles.transmission_bounces = 8
    scene.cycles.glossy_bounces = 6
    scene.render.resolution_x = round(g["w"] * scale)
    scene.render.resolution_y = round(g["h"] * scale)
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    try:  # exact tier hues: no filmic/AgX hue shift
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
    except TypeError as err:
        print("view transform not set:", err)
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"


def render_states(out_dir, name):
    """Render the scene twice: the still frame, and its lit state."""
    for state, suffix in (("base", ""), ("lit", "-lit")):
        set_state(state)
        path = os.path.abspath(os.path.join(out_dir, f"{name}{suffix}.png"))
        bpy.context.scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        print("WROTE", path)


def render_all(out_dir, scale=1.0, samples=192, kinds=KINDS, tiers=TIERS):
    for kind in kinds:
        clear_scene()
        build_scene(kind)
        configure_render(kind, scale, samples)
        for tier in tiers:
            set_tier(tier)
            render_states(out_dir, f"{kind}-{tier}")


def render_prize(name, out_dir, scale=1.0, samples=192, kinds=KINDS):
    for kind in kinds:
        clear_scene()
        build_scene(kind, "common")
        PRIZES[name]()
        configure_render(kind, scale, samples)
        render_states(out_dir, f"{kind}-{name}")


def arg(name, default):
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return argv[argv.index(name) + 1] if name in argv else default


if __name__ == "__main__":
    out = arg("--out", "docs/research/glass-frames")
    scale, samples = float(arg("--scale", "1")), int(arg("--samples", "192"))
    prize = arg("--frame", "")
    if prize:
        render_prize(prize, out, scale, samples)
    else:
        render_all(out, scale, samples)
