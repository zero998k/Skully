# Re-render: pip install bpy==4.2.0 (Python 3.11), then: python mascot.py -- out.png 1024 64
# SolBoy mascot: a grumpy kid with a red bowl cut, freckles and a striped onesie, arms crossed.
# Smooth stylized 3D (no image textures), rendered with Cycles on a transparent background.
import bpy, bmesh, math, sys
from mathutils import Vector, Matrix, Euler

OUT = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else '/tmp/mascot.png'
RES = int(sys.argv[sys.argv.index('--') + 2]) if '--' in sys.argv and len(sys.argv) > sys.argv.index('--') + 2 else 1024
SAMPLES = int(sys.argv[sys.argv.index('--') + 3]) if '--' in sys.argv and len(sys.argv) > sys.argv.index('--') + 3 else 96
STRIPE = (1.0, 0.176, 0.584)  # hot pink #ff2d95 (sRGB)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

def lin(c):
    return tuple(((x / 1.0) / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)

def hexc(h):
    h = h.lstrip('#')
    return lin(tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)))

def mat(name, color, rough=0.45, sss=0.0, coat=0.0, emit=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    if sss:
        b.inputs['Subsurface Weight'].default_value = sss
        b.inputs['Subsurface Radius'].default_value = (1.0, 0.35, 0.2)
        b.inputs['Subsurface Scale'].default_value = 0.05
    if coat:
        b.inputs['Coat Weight'].default_value = coat
        b.inputs['Coat Roughness'].default_value = 0.15
    return m

def stripes(name, axis='Z', freq=26.0, rough=0.5):
    """Smooth procedural stripes from object coordinates (no image texture)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Roughness'].default_value = rough
    b.inputs['Sheen Weight'].default_value = 0.25
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    mul = nt.nodes.new('ShaderNodeMath'); mul.operation = 'MULTIPLY'; mul.inputs[1].default_value = freq
    sin = nt.nodes.new('ShaderNodeMath'); sin.operation = 'SINE'
    smooth = nt.nodes.new('ShaderNodeMapRange'); smooth.inputs['From Min'].default_value = -0.08; smooth.inputs['From Max'].default_value = 0.08
    mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'
    mix.inputs[6].default_value = (*hexc('#ffffff'), 1)
    mix.inputs[7].default_value = (*lin(STRIPE), 1)
    nt.links.new(tc.outputs['Object'], sep.inputs[0])
    nt.links.new(sep.outputs[axis], mul.inputs[0])
    nt.links.new(mul.outputs[0], sin.inputs[0])
    nt.links.new(sin.outputs[0], smooth.inputs['Value'])
    nt.links.new(smooth.outputs[0], mix.inputs[0])
    nt.links.new(mix.outputs[2], b.inputs['Base Color'])
    return m

def smooth_obj(o, subd=2):
    for p in o.data.polygons:
        p.use_smooth = True
    if subd:
        m = o.modifiers.new('subd', 'SUBSURF'); m.levels = subd; m.render_levels = subd

def sphere(name, loc, r, scale=(1, 1, 1), material=None, rot=(0, 0, 0), seg=64, ring=32, subd=1):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=ring, radius=r, location=loc, rotation=rot)
    o = bpy.context.object; o.name = name; o.scale = scale
    smooth_obj(o, subd)
    if material: o.data.materials.append(material)
    return o

skin = mat('skin', hexc('#f7c9a3'), rough=0.5, sss=0.25)
skin_dark = mat('skinShade', hexc('#f0b08b'), rough=0.5, sss=0.2)
hair = mat('hair', hexc('#f2461b'), rough=0.55, coat=0.1)
brow = mat('brow', hexc('#c8300f'), rough=0.4)
white = mat('white', hexc('#ffffff'), rough=0.3, coat=0.4)
black = mat('black', hexc('#141018'), rough=0.2, coat=0.6)
freck = mat('freckle', hexc('#d9703f'), rough=0.6)
blush = mat('blush', hexc('#ff8fb8'), rough=0.6)
mouth = mat('mouth', hexc('#7a1f2b'), rough=0.4)
body_m = stripes('onesie', 'Z', 23.0)
arm_m = stripes('sleeve', 'X', 23.0)

# head: an ellipsoid; helper to sit features on its front surface
HC = Vector((0, 0, 1.55)); A, B, C = 0.62, 0.56, 0.58
head = sphere('head', HC, 1.0, (A, B, C), skin, seg=96, ring=48)
def surf(x, z, push=0.0):
    t = 1 - (x / A) ** 2 - ((z - HC.z) / C) ** 2
    return Vector((x, -B * math.sqrt(max(t, 0.0)) - push, z))

for s in (-1, 1):
    sphere(f'ear{s}', (s * 0.6, 0.02, 1.5), 0.12, (0.55, 0.85, 1.0), skin, seg=48, ring=24)

# bowl-cut hair: a shell of a slightly larger ellipsoid, cut low at the back and just above the brows at the front
bpy.ops.mesh.primitive_uv_sphere_add(segments=128, ring_count=64, radius=1.0, location=HC)
hairo = bpy.context.object; hairo.name = 'hair'
bm = bmesh.new(); bm.from_mesh(hairo.data)
for v in bm.verts:
    v.co = Vector((v.co.x * (A + 0.03), v.co.y * (B + 0.035), v.co.z * (C + 0.035)))
# a clean straight cut: slice along the plane z = 1.43 - 0.38*y, then drop everything below it
n = Vector((0, 0.38, 1)).normalized()
bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, 1.43 - HC.z), plane_no=n, clear_inner=True)
bm.to_mesh(hairo.data); bm.free()
sol = hairo.modifiers.new('thick', 'SOLIDIFY'); sol.thickness = 0.05; sol.offset = 1
smooth_obj(hairo, 2)
hairo.data.materials.append(hair)
# tuft on top
bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=0.08, depth=0.28, location=(0.05, 0.05, 2.2), rotation=(math.radians(-18), math.radians(22), 0))
tuft = bpy.context.object; smooth_obj(tuft, 2); tuft.data.materials.append(hair)

# grumpy eyes: whites, pupils, heavy slanted lids and brows
for s in (-1, 1):
    e = surf(s * 0.205, 1.48, -0.035)
    sphere(f'eye{s}', e, 0.125, (0.8, 0.45, 0.85), white, seg=48, ring=24)
    sphere(f'pupil{s}', e + Vector((-s * 0.018, -0.05, -0.02)), 0.055, (1, 0.55, 1.05), black, seg=32, ring=16)
    sphere(f'lid{s}', e + Vector((0, -0.012, 0.062)), 0.118, (0.98, 0.58, 0.5), skin, rot=(0, math.radians(-s * 24), 0), seg=48, ring=24)
    b = surf(s * 0.205, 1.6, 0.0)
    sphere(f'brow{s}', b, 0.055, (2.5, 0.7, 0.62), brow, rot=(0, math.radians(-s * 30), 0), seg=48, ring=24)

# nose, blush, freckles
sphere('nose', surf(0, 1.36, -0.05), 0.075, (1.1, 0.9, 0.85), skin_dark, seg=48, ring=24)
for s in (-1, 1):
    sphere(f'blush{s}', surf(s * 0.34, 1.33, -0.005), 0.085, (1.3, 0.25, 0.8), blush, seg=48, ring=24)
    for i, (dx, dz) in enumerate(((-0.06, 0.02), (0.0, -0.02), (0.06, 0.015), (0.03, 0.05))):
        sphere(f'freckle{s}{i}', surf(s * 0.34 + dx, 1.33 + dz, 0.012), 0.016, (1, 0.4, 1), freck, seg=24, ring=12, subd=0)

# pouty frown: a curved tube
curve = bpy.data.curves.new('frown', 'CURVE'); curve.dimensions = '3D'; curve.bevel_depth = 0.026; curve.bevel_resolution = 6
sp = curve.splines.new('BEZIER'); sp.bezier_points.add(2)
pts = [surf(-0.1, 1.2, 0.006), surf(0.0, 1.24, 0.014), surf(0.1, 1.2, 0.006)]
for bp, p in zip(sp.bezier_points, pts):
    bp.co = p; bp.handle_left_type = bp.handle_right_type = 'AUTO'
fr = bpy.data.objects.new('frown', curve); scene.collection.objects.link(fr); fr.data.materials.append(mouth)

# body: a smooth onesie made by spinning a profile
prof = [(0.0, 0.0), (0.46, 0.0), (0.5, 0.06), (0.44, 0.2), (0.38, 0.42), (0.41, 0.66), (0.37, 0.86), (0.27, 0.98), (0.2, 1.04), (0.0, 1.06)]
bm = bmesh.new()
vs = [bm.verts.new((r, 0, z)) for r, z in prof]
for a, b2 in zip(vs, vs[1:]): bm.edges.new((a, b2))
bmesh.ops.spin(bm, geom=bm.verts[:] + bm.edges[:], cent=(0, 0, 0), axis=(0, 0, 1), angle=math.radians(360), steps=96, use_merge=True)
me = bpy.data.meshes.new('body'); bm.to_mesh(me); bm.free()
body = bpy.data.objects.new('body', me); scene.collection.objects.link(body)
body.scale = (1.0, 0.86, 1.0); smooth_obj(body, 2); body.data.materials.append(body_m)

# collar
bpy.ops.mesh.primitive_torus_add(major_radius=0.24, minor_radius=0.075, location=(0, 0, 1.03), major_segments=96, minor_segments=32)
col = bpy.context.object; col.scale = (1, 0.9, 0.8); smooth_obj(col, 1); col.data.materials.append(white)

# crossed arms: two striped sleeves with white cuffs, plus round shoulders
for s in (-1, 1):
    sphere(f'shoulder{s}', (s * 0.37, -0.02, 0.84), 0.15, (1, 1, 1), arm_m, seg=48, ring=24)
for s, z, y, tilt in ((1, 0.74, -0.37, 13), (-1, 0.8, -0.42, -13)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=0.125, depth=0.8, location=(0, y, z), rotation=(0, math.radians(90), 0))
    arm = bpy.context.object
    arm.rotation_euler = Euler((math.radians(tilt * 0.4), math.radians(90 + tilt), math.radians(-s * 28)), 'XYZ')
    bev = arm.modifiers.new('bevel', 'BEVEL'); bev.width = 0.06; bev.segments = 6
    smooth_obj(arm, 2); arm.data.materials.append(arm_m)
    end = arm.matrix_world @ Vector((0, 0, s * 0.4))
    sphere(f'cuff{s}', end, 0.115, (1, 1, 1), white, seg=48, ring=24)

# slight grumpy lean: tilt the whole kid
root = bpy.data.objects.new('root', None); scene.collection.objects.link(root)
for o in list(scene.collection.objects):
    if o is not root and o.parent is None:
        o.parent = root
root.rotation_euler = (math.radians(5), 0, math.radians(-12))

# camera and lights
cam_d = bpy.data.cameras.new('cam'); cam_d.lens = 92
cam = bpy.data.objects.new('cam', cam_d); scene.collection.objects.link(cam)
cam.location = (0.0, -7.6, 1.25)
look = Vector((0, 0, 1.12)) - cam.location
cam.rotation_euler = look.to_track_quat('-Z', 'Y').to_euler()
scene.camera = cam

def area(name, loc, power, size, color=(1, 1, 1)):
    d = bpy.data.lights.new(name, 'AREA'); d.energy = power; d.size = size; d.color = color
    o = bpy.data.objects.new(name, d); scene.collection.objects.link(o); o.location = loc
    o.rotation_euler = (Vector((0, 0, 1.2)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
area('key', (-3.2, -4.2, 3.4), 800, 5.0)
area('fill', (3.8, -3.0, 1.6), 380, 4.0, (1.0, 0.95, 0.98))
area('rimPink', (2.6, 3.4, 3.4), 1300, 2.5, (1.0, 0.25, 0.62))
area('rimL', (-3.0, 3.0, 2.4), 600, 2.5, (1.0, 0.8, 0.9))

world = bpy.data.worlds.new('w'); scene.world = world; world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.05, 0.05, 0.06, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6

# render settings: Cycles, transparent background, clean cartoon colours
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.render.film_transparent = True
scene.render.resolution_x = scene.render.resolution_y = RES
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.view_settings.exposure = 0.0
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.filepath = OUT
# a crisp dark outline makes it read like a cartoon sticker
scene.render.use_freestyle = True
scene.render.line_thickness_mode = 'ABSOLUTE'
scene.render.line_thickness = max(1.5, RES / 380)
fs = scene.view_layers[0].freestyle_settings
ls = fs.linesets[0] if len(fs.linesets) else fs.linesets.new('outline')
if ls.linestyle is None: ls.linestyle = bpy.data.linestyles.new('ink')
ls.linestyle.color = (0.04, 0.02, 0.05)
ls.select_by_visibility = True
ls.select_silhouette = True; ls.select_border = True; ls.select_crease = False
outlined = bpy.data.collections.new('outlined'); scene.collection.children.link(outlined)
for name in ('head', 'hair', 'body', 'ear-1', 'ear1', 'shoulder-1', 'shoulder1'):
    if name in bpy.data.objects: outlined.objects.link(bpy.data.objects[name])
for o in bpy.data.objects:
    if o.type == 'MESH' and (o.name.startswith('Cylinder') or o.name.startswith('cuff') or o.name.startswith('Torus')): outlined.objects.link(o)
ls.select_by_collection = True; ls.collection = outlined
bpy.ops.render.render(write_still=True)
print('rendered', OUT)
