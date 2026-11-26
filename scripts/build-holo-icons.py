# Builds the three "holo" 3D icons (crown, gift, vault door) and writes them as
# GLB files into public/3dicons/. Headless:
#
#   "C:/Program Files/Blender Foundation/Blender 5.3/blender.exe" -b --factory-startup \
#       -P scripts/build-holo-icons.py
#
# The storefront draws them live (src/components/holo-3d). Only shape is baked
# here: the look comes from the three material NAMES the runtime swaps for its
# own (body = glossy black, trim = dark chrome, glow = white light), and the
# moving parts are the named pivots (lid, door, wheel).
#
# Blender is Z up with the front at -Y; the exporter turns that into glTF's
# Y up with the front at +Z.

import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "3dicons")
TAU = math.tau


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name):
    return bpy.data.materials.get(name) or bpy.data.materials.new(name)


def add(name, bm, mat, parent=None, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1),
        bevel=0.0, segments=3, subsurf=0):
    """Turns a bmesh into a smooth-shaded object with the usual soft edges."""
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for poly in mesh.polygons:
        poly.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location, obj.rotation_euler, obj.scale = loc, rot, scale
    obj.parent = parent
    mesh.materials.append(material(mat))
    if bevel:
        m = obj.modifiers.new("bevel", "BEVEL")
        m.width, m.segments = bevel, segments
        m.limit_method, m.angle_limit = "ANGLE", math.radians(40)
    if subsurf:
        m = obj.modifiers.new("subsurf", "SUBSURF")
        m.levels = m.render_levels = subsurf
    # Bevel + weighted normals: flat faces stay flat under smooth shading.
    obj.modifiers.new("normals", "WEIGHTED_NORMAL").keep_sharp = False
    return obj


def pivot(name, parent=None, loc=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(obj)
    obj.location, obj.parent = loc, parent
    return obj


def box(x, y, z):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(x, y, z), verts=bm.verts)
    return bm


def cylinder(radius, depth, segments=48):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segments,
                          radius1=radius, radius2=radius, depth=depth)
    return bm


def sphere(radius, u=24, v=14):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=radius)
    return bm


def torus(major, minor, u=56, v=12):
    """A ring around Z."""
    bm = bmesh.new()
    rings = []
    for i in range(u):
        a = TAU * i / u
        ring = []
        for j in range(v):
            b = TAU * j / v
            r = major + minor * math.cos(b)
            ring.append(bm.verts.new((r * math.cos(a), r * math.sin(a), minor * math.sin(b))))
        rings.append(ring)
    for i in range(u):
        for j in range(v):
            bm.faces.new((rings[i][j], rings[(i + 1) % u][j],
                          rings[(i + 1) % u][(j + 1) % v], rings[i][(j + 1) % v]))
    return bm


def export(name):
    os.makedirs(OUT, exist_ok=True)
    wanted = dict(
        filepath=os.path.join(OUT, name + ".glb"), export_format="GLB",
        export_apply=True, export_yup=True, use_selection=False,
        export_cameras=False, export_lights=False, export_animations=False,
        export_texcoords=False, export_tangents=False, export_normals=True,
        export_materials="EXPORT",
    )
    known = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    bpy.ops.export_scene.gltf(**{k: v for k, v in wanted.items() if k in known})
    print("wrote", name, os.path.getsize(wanted["filepath"]), "bytes")


# The front of a Y-axis part: cylinders and rings are built around Z, then
# stood up to face -Y.
FACE = (math.radians(90), 0, 0)


def crown():
    reset()
    points, per = 5, 8
    n = points * per
    radius, low, high = 0.8, 0.5, 1.22
    bm = bmesh.new()
    rows = []
    for i in range(n):
        a = TAU * i / n
        # 1 on a point, 0 in the dip between two.
        peak = (1 - abs(((i / per) % 1) - 0.5) * 2) ** 1.25
        top = low + (high - low) * peak
        flare = 1 + 0.2 * top / high
        rows.append((
            bm.verts.new((radius * math.cos(a), radius * math.sin(a), 0)),
            bm.verts.new((radius * 1.04 * math.cos(a), radius * 1.04 * math.sin(a), low * 0.7)),
            bm.verts.new((radius * flare * math.cos(a), radius * flare * math.sin(a), top)),
        ))
    for i in range(n):
        a, b = rows[i], rows[(i + 1) % n]
        bm.faces.new((a[0], b[0], b[1], a[1]))
        bm.faces.new((a[1], b[1], b[2], a[2]))
    wall = add("crown_wall", bm, "body", subsurf=2)
    solid = wall.modifiers.new("solid", "SOLIDIFY")
    solid.thickness, solid.offset = 0.1, 0
    # Thickness first, then the smoothing.
    bpy.context.view_layer.objects.active = wall
    while wall.modifiers[0].name != "solid":
        bpy.ops.object.modifier_move_up(modifier="solid")

    add("crown_band", torus(radius * 1.01, 0.1), "trim", loc=(0, 0, 0.1), scale=(1, 1, 1.5))
    for k in range(points):
        a = TAU * (k + 0.5) / points
        tip = radius * 1.2
        add(f"crown_tip_{k}", sphere(0.105), "trim",
            loc=(tip * math.cos(a), tip * math.sin(a), high + 0.06))
        gem = radius * 1.11
        add(f"crown_gem_{k}", sphere(0.075, 12, 8), "glow",
            loc=(gem * math.cos(a), gem * math.sin(a), 0.1), scale=(1, 1, 1.25))
    export("crown")


def gift():
    reset()
    w, h, lid_w, lid_h, band = 1.5, 1.05, 1.68, 0.34, 0.3
    add("gift_box", box(w, w, h), "body", loc=(0, 0, h / 2), bevel=0.1, segments=4)
    add("gift_band_x", box(w + 0.04, band, h + 0.01), "trim", loc=(0, 0, h / 2), bevel=0.03)
    add("gift_band_y", box(band, w + 0.04, h + 0.01), "trim", loc=(0, 0, h / 2), bevel=0.03)
    # The light inside: under the lid while it is shut.
    add("light", box(w - 0.22, w - 0.22, 0.02), "glow", loc=(0, 0, h + 0.012))

    lid = pivot("lid", loc=(0, 0, h))
    add("gift_lid", box(lid_w, lid_w, lid_h), "body", lid, (0, 0, lid_h / 2), bevel=0.08, segments=4)
    add("gift_lid_band_x", box(lid_w + 0.04, band, lid_h + 0.03), "trim", lid, (0, 0, lid_h / 2), bevel=0.03)
    add("gift_lid_band_y", box(band, lid_w + 0.04, lid_h + 0.03), "trim", lid, (0, 0, lid_h / 2), bevel=0.03)
    # The bow: four flat loops leaning out from a knot, one along each band, so
    # it reads as a bow from every side.
    for k in range(4):
        a = TAU * k / 4
        add(f"gift_bow_{k}", torus(0.25, 0.055, 40, 10), "trim", lid,
            loc=(0.3 * math.cos(a), 0.3 * math.sin(a), lid_h + 0.17),
            rot=(math.radians(90), math.radians(-24), a), scale=(1.25, 0.72, 2.3))
    add("gift_knot", sphere(0.13), "trim", lid, (0, 0, lid_h + 0.1), scale=(1, 1, 0.85))
    export("gift")


def vault():
    reset()
    r = 0.98
    # The wall it sits in, and the lit room behind the door.
    add("vault_frame", torus(1.13, 0.14), "trim", rot=FACE)
    add("vault_shell", cylinder(1.13, 0.5), "body", loc=(0, 0.27, 0), rot=FACE, bevel=0.05)
    add("light", cylinder(0.95, 0.02), "glow", loc=(0, 0.01, 0), rot=FACE)
    for z in (-0.52, 0.52):
        add(f"vault_hinge_{'a' if z < 0 else 'b'}", box(0.26, 0.22, 0.3), "trim",
            loc=(-1.2, -0.12, z), bevel=0.05)

    # The door swings on its left edge.
    door = pivot("door", loc=(-1.13, -0.02, 0))
    centre = Vector((1.13, 0, 0))
    add("vault_door", cylinder(r, 0.26), "body", door, centre + Vector((0, -0.13, 0)), FACE,
        bevel=0.06)
    add("vault_plate", cylinder(0.7, 0.07), "body", door, centre + Vector((0, -0.29, 0)), FACE,
        bevel=0.03)
    add("vault_ring", torus(0.8, 0.02, 64, 8), "glow", door, centre + Vector((0, -0.262, 0)), FACE)
    for k in range(8):
        a = TAU * (k + 0.5) / 8
        add(f"vault_bolt_{k}", cylinder(0.055, 0.06, 20), "trim", door,
            centre + Vector((0.89 * math.cos(a), -0.28, 0.89 * math.sin(a))), FACE, bevel=0.012)

    add("vault_shaft", cylinder(0.075, 0.12, 24), "trim", door, centre + Vector((0, -0.37, 0)), FACE)
    wheel = pivot("wheel", door, centre + Vector((0, -0.44, 0)))
    add("vault_wheel", torus(0.4, 0.045, 48, 10), "trim", wheel, rot=FACE)
    for k in range(3):
        add(f"vault_spoke_{k}", cylinder(0.034, 0.8, 12), "trim", wheel,
            rot=(0, TAU * k / 6, 0))
    add("vault_hub", cylinder(0.11, 0.12, 28), "trim", wheel, rot=FACE, bevel=0.03)
    export("vault")


crown()
gift()
vault()
