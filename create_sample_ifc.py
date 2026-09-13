"""
Creates the minimal digitalized building required by the PoC: an IFC4 model
with one storey, one space (Room_101) and three maintainable elements placed
at known coordinates. Geometry representations are intentionally omitted --
for the CBM pipeline only spatial placement (ObjectPlacement) and identity
(GlobalId) matter, which keeps the sample tiny and readable.

By default the door sits at (2.5, 1.0, 1.2) so the pipeline resolves to
Door_101 even without a real MultiSet map. With a real map, pass the VPS
`position` of your door photo via --door (see below).

For the toy example the fastest way to get a working demo is to author the
model directly in the MultiSet map frame: localize the door photo once, read
`position` from the VPS response and pass it here, which makes T_map->ifc the
identity and removes the registration step entirely (see the node tutorial).

Requires: pip install "ifcopenshell>=0.8" numpy
Run:      python create_sample_ifc.py
          python create_sample_ifc.py --door -5.895 1.225 2.211   # VPS pose
Output:   ./models/room_v1.ifc + ./models/active_model.txt
"""

import argparse
from pathlib import Path

import numpy as np
import ifcopenshell
import ifcopenshell.api

ap = argparse.ArgumentParser(description="Create the PoC room IFC model.")
ap.add_argument("--door", nargs=3, type=float, metavar=("X", "Y", "Z"),
                default=[2.5, 1.0, 1.2],
                help="Door_101 position. Pass the MultiSet `position` of your "
                     "door photo to make the map and IFC frames coincide.")
ap.add_argument("--window", nargs=3, type=float, metavar=("X", "Y", "Z"),
                default=[5.0, 0.1, 1.5], help="Window_101 position.")
ap.add_argument("--light", nargs=3, type=float, metavar=("X", "Y", "Z"),
                default=[4.0, 3.0, 2.7], help="Light_101 position.")
ap.add_argument("--out", default="room_v1.ifc", help="Output file name.")
args = ap.parse_args()

MODEL_DIR = Path("./models")
MODEL_DIR.mkdir(exist_ok=True)

f = ifcopenshell.api.run("project.create_file", version="IFC4")

project = ifcopenshell.api.run("root.create_entity", f,
                               ifc_class="IfcProject", name="CBM PoC Project")
# Assign EXPLICIT metre units. Calling unit.assign_unit with no arguments
# defaults to millimetres, which would store the door placed at (2.5, 1.0, 1.2)
# as (2500, 1000, 1200) and break the match with the MultiSet pose (metres).
_length_unit = ifcopenshell.api.run("unit.add_si_unit", f, unit_type="LENGTHUNIT")  # METRE
ifcopenshell.api.run("unit.assign_unit", f, units=[_length_unit])
ifcopenshell.api.run("context.add_context", f, context_type="Model")

site = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSite", name="Site")
building = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuilding", name="Building A")
storey = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name="Level 0")

ifcopenshell.api.run("aggregate.assign_object", f, products=[site], relating_object=project)
ifcopenshell.api.run("aggregate.assign_object", f, products=[building], relating_object=site)
ifcopenshell.api.run("aggregate.assign_object", f, products=[storey], relating_object=building)

space = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSpace", name="Room_101")
ifcopenshell.api.run("aggregate.assign_object", f, products=[space], relating_object=storey)


def add_element(ifc_class: str, name: str, x: float, y: float, z: float):
    el = ifcopenshell.api.run("root.create_entity", f, ifc_class=ifc_class, name=name)
    ifcopenshell.api.run("spatial.assign_container", f, products=[el], relating_structure=storey)
    m = np.eye(4)
    m[0][3], m[1][3], m[2][3] = x, y, z
    ifcopenshell.api.run("geometry.edit_object_placement", f, product=el, matrix=m)
    return el


door = add_element("IfcDoor", "Door_101", *args.door)          # = WF1 mock pose
window = add_element("IfcWindow", "Window_101", *args.window)
light = add_element("IfcLightFixture", "Light_101", *args.light)

out = MODEL_DIR / args.out
f.write(str(out))
(MODEL_DIR / "active_model.txt").write_text(out.name)

print(f"Wrote {out}")
print(f"{'Element':<12} {'GlobalId':<24} position")
for el, pos in [(door, args.door), (window, args.window), (light, args.light)]:
    print(f"{el.Name:<12} {el.GlobalId:<24} {tuple(pos)}")
