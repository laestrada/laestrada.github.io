import json
import re
import shutil
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import rasterio
import xarray as xr
from rasterio.enums import Resampling
from rasterio.transform import from_bounds

# ---------- user settings ----------
SCRIPT_DIR = Path(__file__).resolve().parent
APP_DIR = SCRIPT_DIR.parent
EMISSIONS_DIR = (
    APP_DIR.parent
    / "imi_output"
    / "analysis"
    / "emissions"
)
OUT_DIR = APP_DIR / "data"
PERIODS_CSV_CANDIDATES = [
    APP_DIR.parent / "imi_output" / "Marcellus_operational_TROPOMI_12km_KF" / "kf_inversions" / "for_jpl" / "periods.csv",
    APP_DIR.parent / "imi_output" / "Marcellus_operational_TROPOMI_12km_KF" / "periods.csv",
    APP_DIR.parent / "integrated_methane_inversion" / "periods.csv",
]
DEFAULT_DATASET = "posterior"
DEFAULT_VARIABLE = "EmisCH4_Total_ExclSoilAbs"
CLAMP_NEG_TO_ZERO = True
# ----------------------------------

VARIABLES = [
    "EmisCH4_Total_ExclSoilAbs",
    "EmisCH4_Oil",
    "EmisCH4_Gas",
    "EmisCH4_Coal",
    "EmisCH4_Livestock",
    "EmisCH4_Landfills",
    "EmisCH4_Wastewater",
    "EmisCH4_Rice",
    "EmisCH4_Reservoirs",
    "EmisCH4_OtherAnth",
    "EmisCH4_Wetlands",
    "EmisCH4_Lakes",
    "EmisCH4_BiomassBurn",
    "EmisCH4_Seeps",
    "EmisCH4_Termites",
]

VARIABLE_LABELS = {
    "EmisCH4_Total_ExclSoilAbs": "Total",
    "EmisCH4_Oil": "Oil",
    "EmisCH4_Gas": "Gas",
    "EmisCH4_Coal": "Coal",
    "EmisCH4_Livestock": "Livestock",
    "EmisCH4_Landfills": "Landfills",
    "EmisCH4_Wastewater": "Wastewater",
    "EmisCH4_Rice": "Rice",
    "EmisCH4_Reservoirs": "Reservoirs",
    "EmisCH4_OtherAnth": "Other Anthro",
    "EmisCH4_Wetlands": "Wetlands",
    "EmisCH4_Lakes": "Lakes",
    "EmisCH4_BiomassBurn": "Biomass Burning",
    "EmisCH4_Seeps": "Seeps",
    "EmisCH4_Termites" : "Termites",
}

DATASET_LABELS = {
    "prior": "GHGI",
    "posterior": "TROPOMI estimate",
    "blended_posterior": "Blended TROPOMI+GOSAT estimate",
    "posterior_blended": "Blended TROPOMI+GOSAT estimate",
}

EXCLUDED_DATASETS = {"kalman_prior"}

DATASET_PATH_KEYS = {
    ("operational_emissions", "prior"): "prior",
    ("operational_emissions", "posterior"): "posterior",
    ("operational_emissions", "kalman_prior"): "kalman_prior",
    ("blended_emissions", "posterior"): "blended_posterior",
}


def slug_label(key: str) -> str:
    return key.replace("_", " ").strip().title()


def find_periods_csv() -> Path:
    for candidate in PERIODS_CSV_CANDIDATES:
        if candidate.exists():
            return candidate
    raise FileNotFoundError("Could not locate periods.csv")


def load_periods() -> dict[str, dict]:
    periods_path = find_periods_csv()
    periods_df = pd.read_csv(periods_path)
    periods = {}

    for row in periods_df.itertuples(index=False):
        period_key = str(int(row.period_number))
        start = datetime.strptime(str(int(row.Starts)), "%Y%m%d")
        end = datetime.strptime(str(int(row.Ends)), "%Y%m%d")
        periods[period_key] = {
            "key": period_key,
            "label": start.strftime("%b %Y"),
            "start": start.strftime("%Y-%m-%d"),
            "end": end.strftime("%Y-%m-%d"),
            "days": (end - start).days,
        }

    return periods


def extract_period_key(path: Path) -> str:
    match = re.search(r"period(\d+)", path.stem)
    if not match:
        raise ValueError(f"Could not infer period from {path.name}")
    return str(int(match.group(1)))


def dataset_sources() -> list[tuple[str, Path]]:
    sources: list[tuple[str, Path]] = []
    for path in sorted(EMISSIONS_DIR.glob("*/*")):
        if not path.is_dir():
            continue
        dataset_key = DATASET_PATH_KEYS.get((path.parent.name, path.name))
        if dataset_key is None or dataset_key in EXCLUDED_DATASETS:
            continue
        if any(path.glob("*.nc")):
            sources.append((dataset_key, path))
    return sources


def safe_float(value) -> float:
    return float(value) if np.isfinite(value) else 0.0


def ensure_north_up(arr: np.ndarray, lat: np.ndarray, area: np.ndarray | None = None):
    if lat[0] < lat[-1]:
        arr = arr[::-1, :]
        if area is not None:
            area = area[::-1, :]
    return arr, area


def prepare_array(da: xr.DataArray) -> np.ndarray:
    arr = da.values.astype("float32")
    if CLAMP_NEG_TO_ZERO:
        arr = np.where(np.isfinite(arr) & (arr < 0), 0.0, arr)
    arr = np.where(np.isfinite(arr), arr, np.nan)
    return arr


def copy_source_nc(nc_path: Path, dataset_key: str) -> str:
    target_dir = OUT_DIR / "nc" / dataset_key
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / nc_path.name
    if not target_path.exists():
        shutil.copy2(nc_path, target_path)
    return str(target_path.relative_to(APP_DIR)).replace("\\", "/")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tif_root = OUT_DIR / "tif"
    tif_root.mkdir(parents=True, exist_ok=True)

    periods = load_periods()
    manifest = {
        "title": "Near-Real-Time Beta Methane Emissions Explorer",
        "description": "Monthly methane emissions for Mid-Atlantic U.S. generated with the IMI using TROPOMI satellite data. See Estrada et al. (202X) for details.",
        "region": {
            "name": "Mid-Atlantic U.S.",
            "source_dir": str(EMISSIONS_DIR.relative_to(APP_DIR.parent)).replace("\\", "/"),
        },
        "defaults": {
            "dataset": DEFAULT_DATASET,
            "variable": DEFAULT_VARIABLE,
        },
        "datasets": [],
        "variables": [{"key": key, "label": VARIABLE_LABELS.get(key, key)} for key in VARIABLES],
        "periods": [],
        "data": {},
        "bounds": None,
        "grid_units_html": "kg h<sup>-1</sup>",
        "summary_unit": "kg/month",
    }

    for dataset_key, dataset_dir in dataset_sources():
        dataset_label = DATASET_LABELS.get(dataset_key, slug_label(dataset_key))
        manifest["datasets"].append({"key": dataset_key, "label": dataset_label})
        manifest["data"][dataset_key] = {}

        for nc_path in sorted(dataset_dir.glob("*.nc")):
            period_key = extract_period_key(nc_path)
            period_meta = periods.get(period_key)
            if period_meta is None:
                raise KeyError(f"Missing period metadata for period {period_key}")

            print(f"\nProcessing {dataset_key} / {nc_path.name} ({period_meta['label']})")

            ds = xr.open_dataset(nc_path)

            lon = ds["lon"].values
            lat = ds["lat"].values
            area = ds["AREA"].values.astype("float64")
            left, right = float(lon.min()), float(lon.max())
            bottom, top = float(lat.min()), float(lat.max())

            if manifest["bounds"] is None:
                manifest["bounds"] = {
                    "west": left,
                    "east": right,
                    "south": bottom,
                    "north": top,
                }

            height = len(lat)
            width = len(lon)
            transform = from_bounds(left, bottom, right, top, width, height)
            seconds_in_period = period_meta["days"] * 24 * 60 * 60
            nc_rel_path = copy_source_nc(nc_path, dataset_key)

            for variable in VARIABLES:
                if variable not in ds:
                    print(f"Skipping {variable} (missing in {nc_path.name})")
                    continue

                da = ds[variable]
                map_arr = prepare_array(da * area * 60 * 60)
                total_arr = prepare_array(da)
                map_arr, _ = ensure_north_up(map_arr, lat)
                total_arr, area_north = ensure_north_up(total_arr, lat, area)

                tif_dir = tif_root / dataset_key
                tif_dir.mkdir(parents=True, exist_ok=True)
                tif_name = f"{variable}_period{int(period_key):03d}.tif"
                tif_path = tif_dir / tif_name

                profile = dict(
                    driver="GTiff",
                    height=height,
                    width=width,
                    count=1,
                    dtype="float32",
                    crs="EPSG:4326",
                    transform=transform,
                    nodata=np.nan,
                    tiled=True,
                    blockxsize=256,
                    blockysize=256,
                    compress="DEFLATE",
                    predictor=3,
                )

                with rasterio.open(tif_path, "w", **profile) as dst:
                    dst.write(map_arr, 1)
                    dst.build_overviews([2, 4, 8, 16], Resampling.average)
                    dst.update_tags(ns="rio_overview", resampling="average")

                if np.isfinite(map_arr).any():
                    vmin = safe_float(np.nanmin(map_arr))
                    vmax = safe_float(np.nanmax(map_arr))
                else:
                    vmin = 0.0
                    vmax = 0.0

                total_kg = 0.0
                if area_north is not None and np.isfinite(total_arr).any():
                    total_kg = safe_float(np.nansum(total_arr.astype("float64") * area_north * seconds_in_period))

                manifest["data"][dataset_key].setdefault(variable, {})
                manifest["data"][dataset_key][variable][period_key] = {
                    "tif": str(tif_path.relative_to(APP_DIR)).replace("\\", "/"),
                    "nc": nc_rel_path,
                    "min": vmin,
                    "max": vmax,
                    "total_kg": total_kg,
                }

                print(f"Wrote {tif_path}")

            ds.close()

    period_keys = sorted(
        {
            period_key
            for dataset_data in manifest["data"].values()
            for variable_data in dataset_data.values()
            for period_key in variable_data.keys()
        },
        key=lambda value: int(value),
    )
    manifest["periods"] = [periods[key] for key in period_keys if key in periods]

    manifest_path = OUT_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"Wrote {manifest_path}")


if __name__ == "__main__":
    main()
