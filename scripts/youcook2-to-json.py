# YouCook2 validation annotations (parquet) → data/public/youcook2-val.json, grouped by video, for eval-workmap.mjs.
#   curl -L -o data/public/youcook2-val.parquet https://huggingface.co/datasets/lmms-eval/YouCook2/resolve/main/data/val-00000-of-00001.parquet
#   python scripts/youcook2-to-json.py
import json, collections, pyarrow.parquet as pq
rows = pq.read_table("data/public/youcook2-val.parquet").to_pylist()
videos = collections.OrderedDict()
for r in rows:
    v = videos.setdefault(r["youtube_id"], {"id": r["youtube_id"], "recipeType": r["recipe_type"], "segments": []})
    v["segments"].append({"start": r["segment"][0], "end": r["segment"][1], "sentence": r["sentence"]})
json.dump(list(videos.values()), open("data/public/youcook2-val.json", "w"))
print(len(videos), "videos")
