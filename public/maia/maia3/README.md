Place the Maia v3 ONNX model and moves map here.

Required files:
- maia_rapid.onnx    (Maia v3 ONNX model)
- all_moves.json     (JSON map of UCI -> move index used by the ONNX model)

Recommended source:
- Obtain model and moves map from the official Maia project distribution or
  the CSSLab maia-platform-frontend repository. Ensure the model matches
  the expected input/output tensor names used by `src/maiaEngine.ts`.

After placing the files, restart the dev server so the files are served
from `/maia/maia3/`.
