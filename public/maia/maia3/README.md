Maia-3 assets for the browser inference path belong here. Run `npm run
prepare:maia` from the repository root to download the Maia-3 79M fp16 ONNX
export and its matching 4,352-move vocabulary into this directory.

The assets are `maia3-79m.fp16.onnx` and `all_moves.json`. The model is the
browser-ready ONNX export from [bqrio/maia3-onnx](https://huggingface.co/bqrio/maia3-onnx),
derived from the official [CSSLab Maia-3](https://github.com/CSSLab/maia3)
release. The model and move vocabulary must be kept together because indices
are specific to the Maia-3 policy head.

Maia-3 is AGPL-3.0 licensed. The 79M fp16 model is about 156 MB and is fetched
separately from the source tree. The app serves it locally from `/maia/maia3/`.
