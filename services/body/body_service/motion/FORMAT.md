# Motion data formats (P1 → P2 / web worker)

Version string: `motion-rig-v1` (`motion/config.py MOTION_VERSION`).

## Coordinate frame
Metres, the body service scene frame. **X = the subject's LEFT**, Y up, **+Z = front**, and the
feet are on Y = 0. It is the same frame as `/body/{id}/mesh.glb` and the garment assets.
Contract angles (`prompts/motion-contract.md`) are degrees. They are measured with P3's formulas
against the **calibrated vertical**: the rest trunk axis (mid-hip → mid-shoulder, about 3° forward
of gravity on Anny), exactly as P3 calibrates on a neutral stance. Rig metadata carries it as
`calibrated_vertical`.

## Container `SATB` (all `.bin` endpoints)
| offset | type | content |
| --- | --- | --- |
| 0 | 4 bytes | magic `SATB` |
| 4 | uint32 LE | container version = 1 |
| 8 | uint32 LE | header length H (space-padded so 12 + H is a multiple of 16) |
| 12 | H bytes | UTF-8 JSON header `{kind, …, blobs: [{name, dtype, shape, offset, byteLength}]}` |
| … | blobs | little-endian, every blob starts at a multiple of 16; `offset` counts from byte 0 |

dtypes: `float32`, `uint32`, `int32`, `uint16`, `uint8`. Arrays are C order (last index fastest).
TS: `new Float32Array(buf, offset, byteLength / 4)`.

## `GET /motion/{body_id}/rig.bin` (kind `rig`)
Header: `bones` (104 labels), `parents`, `drivers` (bone indices of the 18 driven bones),
`skinning` (`"lbs"`), `neutral_pose` (this body's display pose in contract angles),
`calibrated_vertical`, `frame`, `version`.

| blob | shape | meaning |
| --- | --- | --- |
| `rest_world` | (104, 4, 4) f32 | rest world pose `R_b` of every bone (row-major 4×4) |
| `rest_vertices` | (13718, 3) f32 | rest vertices (identical to the body GLB) |
| `faces` | (27420, 3) u32 | triangles |
| `skin_indices` | (13718, 9) u16 | Anny bone index per influence |
| `skin_weights` | (13718, 9) f32 | weights (sum to 1) |
| `driver_of_bone` | (104,) u8 | index into the per-frame driver matrices for every bone |

Only 18 bones are ever rotated (root, spine05..01, clavicles, upperarm01, lowerarm01,
upperleg01, lowerleg01, feet). Every other bone inherits its driver's skinning transform
exactly, so frames send only the drivers. **Shader (LBS, same as Anny and the display pose):**
`p' = Σ_k w_k · M[driver_of_bone[skin_indices_k]] · [p, 1]`. You can bake
`driver_of_bone[skin_indices]` once into a u8 attribute; the per-frame uniform is then 18 mat3x4.

## `GET /motion/{body_id}/{motion_id}/frames.bin` (kind `motion-frames`)
30 fps; frame i is at t = i / 30 s, and frame 0 and the last frame are the body's neutral
(display) pose. Header:
- `motion`: id, label, duration_s, `hold {start_s, end_s}` (measure here), keyframes;
- `poses`: per frame, the clamped `AnatomicalPose` with the solved `pelvis_drop_m`;
- `frames`: per frame, `t_s`, `seated`, `root_offset_m` (foot-planting translation), `ankle_deg`
  (implied, + = dorsiflexion), `clamps`, `warnings`;
- `anchor_order`.

| blob | shape | meaning |
| --- | --- | --- |
| `driver_matrices` | (F, 18, 3, 4) f32 | skinning transforms `T = W · R⁻¹` of the drivers (top 3 rows) |
| `anchor.ring.<name>` | (F, 32, 3) | posed ring points; `<name>` ∈ waist, hip, chest, waistband_low/mid/high |
| `anchor.up.waistband_<lvl>` | (F, 32, 3) | unit local torso "up" at each waistband point (rest +Y carried by skinning) |
| `anchor.tape.waist` / `anchor.tape.hip` | (F, n, 3) | the exact measurement tapes (docs/MEASUREMENTS.md), skinned |
| `anchor.points` | (F, 4, 3) | surface landmarks wrist_L, wrist_R, elbow_L, elbow_R |
| `anchor.joints` | (F, 4, 3) | joint centres wrist.L, wrist.R, lowerarm01.L (elbow), lowerarm01.R |
| `anchor.seat_height` | (F, 1) | lowest thigh/buttock point; the implied chair seat when `seated` |

Ring index: 0 = front centre, 8 = subject's left side, 16 = back centre, 24 = right side
(11.25° steps, cast at rest from the torso section centre). Waistband per the contract:
low = hip line, mid (default) = halfway, high = waist line.

**P2 recipes:**
- Hem gap at ring index i: `gap = (hem_i − ring.waistband_<lvl>[i]) · up.waistband_<lvl>[i]`.
  Here hem_i is the hem point nearest to the vertical line through ring point i. `up` points
  upward, so a **positive** gap means the hem rides above the waistband and skin is exposed. A
  negative gap means the hem is below the waistband, so the body is covered. (Corrected
  2026-11-12; P2's implementation uses this sign.)
- Wrist exposure: project the cuff edge onto the forearm axis `joints[elbow] → joints[wrist]`
  and compare with `points[wrist]`.
- Exposed region: `exposure_vertices[level]` from `/anchors`. These are torso skin vertices
  between the waistband and the chest line, front and back. Skin them with the frame's
  matrices and test whether the garment covers them.

## `POST /motion/{body_id}/custom/frames.bin` (kind `motion-frames`)
A recorded move (prompt 14, "Record a move"): the same container as a preset's frames, from
a pose sequence the client sends. Request (JSON, `custom.py CustomMotionRequest`):

```json
{"fps": 30, "poses": [{"t": 0, "pose": {"shoulder_R_elevation": 41.2}}, {"t": 0.033, "pose": {}}]}
```

- `t`: seconds from the start of the recording; the first is 0, strictly increasing, at most
  `CUSTOM_MAX_DURATION_S` (8 s).
- `pose`: a **partial** `AnatomicalPose`. A DOF that is left out takes the body's neutral
  (display) value, exactly like a DOF a preset keyframe does not list. The client leaves out
  DOFs it could not estimate (low confidence) instead of inventing them.
- `fps`: the nominal input rate, `CUSTOM_FPS_RANGE` (1–60 Hz). At most
  `ceil(8 · fps) + 1` poses.
- Rejected with 422: unknown fields, unknown DOFs, non-finite numbers, angles outside
  `config.LIMITS_DEG`, `pelvis_drop_m` outside 0–0.6. The 422 body lists `loc`, `msg` and
  `type` only; it never echoes the poses.

The samples become the keyframes of a `Motion` with id `custom`. It then goes through exactly
the preset path: `resolve` → `sample` (smoothstep between consecutive samples) →
`pose_skeleton` (same rig, clamping, trunk solve, pelvis drop and foot planting), at 30 fps.
A request built from a preset's keyframes returns that preset's frames bit for bit; only the
header's `motion` descriptor differs (`tests/test_motion_custom.py`).

If the first (last) pose is not the empty neutral pose, a neutral keyframe is added before
(after) it, so the cloth starts from its settled drape, as in every preset. The transition lasts
max(`CUSTOM_LEAD_S` = 0.5 s, largest angle change / `CUSTOM_LEAD_SPEED_DEG_S` = 110 deg/s), so it
is never faster than the presets' validated ramp (reach_up_both: 143 deg in 1.3 s). A fixed
0.8 s lead-in to arms already overhead made the cloth lose both sleeves before the recording
started. `motion.hold` is the recorded window `[lead_in, lead_in + span]`.

The poses are never logged and never cached. Only the timing (`frames.custom`) is kept.

## `GET /motion/{body_id}/anchors` (JSON)
Static attachments, so anchors can also be skinned on the client. `rings` and `tapes` give
`{vertices (N,3), weights (N,3) barycentric, rest (N,3)}`. The response also has `points`
(vertex ids), `heights_m` (rest line heights), `exposure_vertices {low, mid, high}`,
`ring_samples`, `ring_index`, and `waistband_default` = `"mid"`.

## `GET /motion/{body_id}/sdf.bin` (kind `articulated-sdf`)
The body distance is **hybrid**: rigid per-segment grids for the near-rigid skin, plus an
exact query on the skinned joint-zone triangles. LBS blends that skin between two bones, so no
rigid field can follow it (docs/validation/motion-sdf.md has the numbers).

Header `segments[]`: one entry per segment that has a rigid core, i.e. skin weight ≥
`core_weight` (0.9) on the segment's bones. The smoothly blended mid-spine segments have no
core and are omitted. Each entry is `{name, bone, bone_label, local_from_rest (4×4 = R_bone⁻¹),
origin (3), dims (nx,ny,nz), spacing (0.006 m), centre (3, local), radius, blob}`.

| blob | shape | meaning |
| --- | --- | --- |
| `sdf.<name>` | (nx, ny, nz) f32 | signed distance of the closed core (negative inside), metres. Node (i,j,k) sits at local point `origin + (i,j,k)·spacing`; flat index `(i·ny + j)·nz + k` |
| `zone_faces` | (Z, 3) u32 | rest vertex ids of the joint-zone triangles (≈5.4k of 27.4k) |
| `zone_border_edges` | (E, 2) u32 | vertex-id pairs on the open border of the zone |

**Runtime sampling (Python reference: `collision.body_distance`):**
1. Rigid part. For each segment, take `T = driver_matrices[f][driver_of_bone[bone]]` as a 4×4
   and compute `local = local_from_rest · T⁻¹ · p` (= `W_bone⁻¹ · p`).
   - Culling: `lower = |local − centre| − radius`. Skip the segment if `lower > 0` and
     `lower ≥ best`.
   - Let g = (local − origin) / spacing. Clamp g to [0, dims − 1] and sample trilinearly. If
     g was clamped, add `|g − clamp(g)|·spacing` (an upper bound; grids are padded 6 cm).
   - Rigid distance = minimum over segments.
2. Zone part. Skin the zone vertices with the frame's matrices; you already skin them for
   rendering. Find the closest point on the zone triangles, using a spatial hash or BVH
   rebuilt per frame.
   - If that closest point lies on a border edge or border vertex, ignore the zone for this
     point (+∞): the adjacent rigid core is decisive there.
   - Otherwise the distance is signed by the angle-weighted pseudo-normal of the closest
     feature (face, edge or vertex).
3. Body distance = min(rigid, zone). Gradient: central differences, or the direction to the
   closest point.

Cores are closed by centroid fans over their boundary loops before their field is built.
## Anatomical DOF → Anny bones
| DOF | bones rotated (pivot = bone head) | axis / rule |
| --- | --- | --- |
| trunk_flexion | 55 %: whole skeleton about the hip-joint axis; 45 %: spine05..spine01 split by flexion share (36/29/24/33/31) | −right axis (tips the vertical toward the front). Solved so the measured trunk-axis flexion is exact |
| trunk_lateral | spine05..spine01, share 9/14/14/28/41 | forward axis (+ = lean right). Solved |
| trunk_twist | spine05..spine01, share 3/4/4/14/57 | vertical axis (+ = shoulders turn left). Solved |
| shoulder_{L,R}_plane / elevation / axial | clavicle.{s} (shrug 0.1° per ° of elevation above 30°), then upperarm01.{s} | ISB `Ry(plane)·Rx(−elev)·Ry(axial)` in the posed thorax frame (mid-hip → mid-shoulder, shoulder line ⊥, left side mirrored). The humerus frame is set exactly |
| elbow_{L,R}_flexion | lowerarm01.{s} | about the humeral flexion axis; absolute angle |
| hip_{L,R}_flexion | upperleg01.{s} | rotation about the right axis so the thigh's sagittal angle from the vertical equals the value (independent of the trunk) |
| knee_{L,R}_flexion | lowerleg01.{s} | in the shank's own flexion plane; the 3D thigh–shank angle equals the value |
| (feet) | foot.{s} | restored to the rest orientation (flat); implied ankle angle reported |
| pelvis_drop_m | root translation | solved: the lowest sole vertex is put on Y = 0 and the mid-foot keeps its rest x/z |

Fingers, toes, face, neck and upperarm02/lowerarm02/upperleg02/lowerleg02 follow their driver
rigidly.
