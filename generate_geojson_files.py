import urllib.request
import json
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

# 対象JISコードリスト
ward_codes = ["34101", "34102", "34103", "34104", "34105", "34106", "34107", "34108"]
muni_codes = [
    "34202", "34203", "34204", "34205", "34207", "34208", "34209", "34210", 
    "34211", "34212", "34213", "34214", "34215", "34302", "34304", "34307", 
    "34309", "34368", "34369", "34431", "34462", "34545"
]

output_dir = r"C:\Users\ipp31\.gemini\antigravity\scratch\hiroshima-map"
os.makedirs(output_dir, exist_ok=True)

# GeoJSONテンプレート
wards_geojson = {"type": "FeatureCollection", "features": []}
muni_geojson = {"type": "FeatureCollection", "features": []}

def download_and_parse(code):
    url = f"https://raw.githubusercontent.com/niiyz/JapanCityGeoJson/master/geojson/34/{code}.json"
    try:
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        )
        with urllib.request.urlopen(req, timeout=15) as response:
            if response.status == 200:
                content = response.read().decode('utf-8')
                return json.loads(content)
    except Exception as e:
        print(f"Failed to download {code}: {e}")
    return None

# 1. 広島市8区の処理
print("Downloading Hiroshima wards...")
for code in ward_codes:
    data = download_and_parse(code)
    if data and "features" in data:
        for feature in data["features"]:
            props = feature.get("properties", {})
            ward_name = props.get("N03_004", "")
            
            # Wards GeoJSON向け
            ward_feature = json.loads(json.dumps(feature)) # ディープコピー
            ward_feature["properties"] = {
                "code": code,
                "name": ward_name,
                "city": "広島市"
            }
            wards_geojson["features"].append(ward_feature)
            
            # Municipalities GeoJSON向け (広島市全体を1つとして表示するために name を「広島市」に統一する)
            muni_feature = json.loads(json.dumps(feature))
            muni_feature["properties"] = {
                "code": code,
                "name": "広島市"
            }
            muni_geojson["features"].append(muni_feature)
        print(f"--> Processed ward code {code} ({ward_name})")

# 2. その他の市町村の処理
print("\nDownloading other municipalities...")
for code in muni_codes:
    data = download_and_parse(code)
    if data and "features" in data:
        for feature in data["features"]:
            props = feature.get("properties", {})
            muni_name = props.get("N03_004", "")
            
            muni_feature = json.loads(json.dumps(feature))
            muni_feature["properties"] = {
                "code": code,
                "name": muni_name
            }
            muni_geojson["features"].append(muni_feature)
        print(f"--> Processed municipality code {code} ({muni_name})")

# ファイル保存
wards_path = os.path.join(output_dir, "hiroshima_wards.geojson")
with open(wards_path, "w", encoding="utf-8") as f:
    json.dump(wards_geojson, f, ensure_ascii=False)
print(f"\nSaved wards GeoJSON to: {wards_path} (Total features: {len(wards_geojson['features'])})")

muni_path = os.path.join(output_dir, "hiroshima_municipalities.geojson")
with open(muni_path, "w", encoding="utf-8") as f:
    json.dump(muni_geojson, f, ensure_ascii=False)
print(f"Saved municipalities GeoJSON to: {muni_path} (Total features: {len(muni_geojson['features'])})")

print("\nAll tasks completed successfully!")
