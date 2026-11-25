# Render the raw card back ("Raised mark", owner 2026-11-24): a matte black
# card with the Polycards mark and wordmark raised from it in white, lit from
# the top left like the glass tier frames it is shown inside. The mark is real
# relief (a height map moves the mesh), so its shading and shadow are rendered,
# not painted. scripts/compose-card-back.mjs makes the height map and ships the
# result; see the steps there.
#
#   blender -b --factory-startup -P scripts/render-card-back.py -- \
#     [--mask docs/research/card-back/mask.png] \
#     [--out docs/research/card-back/render.png] [--scale 1] [--samples 128]
#     [--size 1200x1680]
#
# The slab's back label is the same stock and ink, rendered here at its own
# size (--size 1363x392; steps in scripts/compose-slab-case.mjs).
#
# 1 px = 0.01 Blender units. CPU on purpose: a GPU render crashed this PC's
# session once (2026-11-21).
import os
import sys

import bpy

U = 0.01

LOOK = dict(
    relief=14,  # height of the raised mark, px
    paper=0.006,  # card colour (linear): a soft black, not a hole
    paper_roughness=0.62,
    paper_sheen=0.2,  # Specular IOR Level of the paper (0.5 = plain plastic)
    grain=0.05,  # strength of the paper's fine tooth
    ink=0.82,  # the mark's white (linear albedo)
    ink_roughness=0.42,
    key=12000.0,  # the one soft light, top left
    fill=300.0,  # a dim light from straight above, so no side goes dead
)


def arg(name, default):
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return argv[argv.index(name) + 1] if name in argv else default


W, H = (int(v) for v in arg("--size", "1200x1680").split("x"))  # the card face, 5:7


def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)


def card(mask, scale):
    """The card: a flat sheet, one vertex per rendered pixel, pushed up where
    the height map is white."""
    bpy.ops.mesh.primitive_grid_add(
        x_subdivisions=round(W * scale), y_subdivisions=round(H * scale), size=1
    )
    ob = bpy.context.object
    ob.scale = (W * U, H * U, 1)
    bpy.ops.object.shade_smooth()
    tex = bpy.data.textures.new("relief", "IMAGE")
    tex.image = mask
    tex.extension = "EXTEND"
    mod = ob.modifiers.new("relief", "DISPLACE")
    mod.texture = tex
    mod.texture_coords = "UV"
    mod.direction = "Z"
    mod.mid_level = 0.0
    mod.strength = LOOK["relief"] * U
    return ob


def material(mask):
    mat = bpy.data.materials.new("card")
    mat.use_nodes = True
    nt = mat.node_tree
    b = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    img = nt.nodes.new("ShaderNodeTexImage")
    img.image = mask
    img.extension = "EXTEND"
    # Ink covers the top of the relief and most of its shoulders.
    edge = nt.nodes.new("ShaderNodeMapRange")
    edge.interpolation_type = "SMOOTHSTEP"
    edge.inputs["From Min"].default_value = 0.3
    edge.inputs["From Max"].default_value = 0.55
    nt.links.new(img.outputs["Color"], edge.inputs["Value"])

    def blend(a, b_value, socket):
        n = nt.nodes.new("ShaderNodeMapRange")
        n.inputs["To Min"].default_value = a
        n.inputs["To Max"].default_value = b_value
        nt.links.new(edge.outputs["Result"], n.inputs["Value"])
        nt.links.new(n.outputs["Result"], socket)

    blend(LOOK["paper"], LOOK["ink"], b.inputs["Base Color"])
    blend(LOOK["paper_roughness"], LOOK["ink_roughness"], b.inputs["Roughness"])
    # Less sheen on the paper, or the light's side of the card goes grey.
    blend(LOOK["paper_sheen"], 0.5, b.inputs["Specular IOR Level"])
    # Fine paper tooth, far below the size of the mark.
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 900.0
    noise.inputs["Detail"].default_value = 3.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = LOOK["grain"]
    bump.inputs["Distance"].default_value = 0.01
    nt.links.new(noise.outputs["Factor"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    return mat


def area_light(name, location, size, power):
    data = bpy.data.lights.new(name, "AREA")
    data.shape = "SQUARE"
    data.size = size
    data.energy = power
    ob = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = location
    ob.rotation_euler = (-ob.location).to_track_quat("-Z", "Y").to_euler()
    return ob


def build(mask_path, scale):
    scene = bpy.context.scene
    clear_scene()
    mask = bpy.data.images.load(os.path.abspath(mask_path))
    mask.colorspace_settings.name = "Non-Color"
    card(mask, scale).data.materials.append(material(mask))
    # Same side as the tier-frame studio's key light.
    area_light("key", (-14.4, 20.8, 22.4), 22, LOOK["key"])
    area_light("fill", (0, 0, 30), 30, LOOK["fill"])

    world = scene.world or bpy.data.worlds.new("world")
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0.0, 0.0, 0.0, 1)
    scene.world = world

    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = max(W, H) * U  # the camera's scale is its longer side
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (0, 0, 50)
    scene.camera = cam


def configure(scale, samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x = round(W * scale)
    scene.render.resolution_y = round(H * scale)
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    try:  # plain whites and blacks: no filmic/AgX tone curve
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
    except TypeError as err:
        print("view transform not set:", err)
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"


if __name__ == "__main__":
    scale = float(arg("--scale", "1"))
    build(arg("--mask", "docs/research/card-back/mask.png"), scale)
    configure(scale, int(arg("--samples", "128")))
    out = os.path.abspath(arg("--out", "docs/research/card-back/render.png"))
    bpy.context.scene.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print("WROTE", out)
