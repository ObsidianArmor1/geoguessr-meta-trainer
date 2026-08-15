(function (root) {
  "use strict";

  const textDecoder = new TextDecoder();

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function unit(values) {
    let square = 0;
    for (const value of values) square += value * value;
    const scale = 1 / Math.max(Math.sqrt(square), 1e-12);
    const output = new Float32Array(values.length);
    for (let index = 0; index < values.length; index += 1) {
      output[index] = values[index] * scale;
    }
    return output;
  }

  function floatArray(buffer) {
    return new Float32Array(
      buffer.slice(buffer.byteOffset || 0, (buffer.byteOffset || 0) + buffer.byteLength),
    );
  }

  function intArray(buffer) {
    return new Int32Array(
      buffer.slice(buffer.byteOffset || 0, (buffer.byteOffset || 0) + buffer.byteLength),
    );
  }

  function topKHeap(values, count) {
    const sizeLimit = Math.min(count, values.length);
    const heapScores = new Float32Array(sizeLimit);
    const heapIds = new Int32Array(sizeLimit);
    let size = 0;
    const swap = (left, right) => {
      const score = heapScores[left];
      heapScores[left] = heapScores[right];
      heapScores[right] = score;
      const id = heapIds[left];
      heapIds[left] = heapIds[right];
      heapIds[right] = id;
    };
    const up = (position) => {
      let at = position;
      while (at) {
        const parent = (at - 1) >> 1;
        if (heapScores[parent] <= heapScores[at]) break;
        swap(parent, at);
        at = parent;
      }
    };
    const down = (position) => {
      let at = position;
      while (true) {
        let child = at * 2 + 1;
        if (child >= size) break;
        if (child + 1 < size && heapScores[child + 1] < heapScores[child]) child += 1;
        if (heapScores[at] <= heapScores[child]) break;
        swap(at, child);
        at = child;
      }
    };
    for (let id = 0; id < values.length; id += 1) {
      const score = values[id];
      if (size < sizeLimit) {
        heapScores[size] = score;
        heapIds[size] = id;
        up(size);
        size += 1;
      } else if (score > heapScores[0]) {
        heapScores[0] = score;
        heapIds[0] = id;
        down(0);
      }
    }
    const rows = Array.from({ length: size }, (_value, index) => ({
      row: heapIds[index], score: heapScores[index],
    }));
    rows.sort((left, right) => right.score - left.score);
    return rows;
  }

  function thumbnail(panoId, heading, width = 448, height = 256) {
    const query = new URLSearchParams({
      cb_client: "apiv3",
      w: String(width),
      h: String(height),
      pitch: "0",
      panoid: panoId,
      yaw: String(heading),
      thumbfov: "90",
    });
    return `https://streetviewpixels-pa.googleapis.com/v1/thumbnail?${query}`;
  }

  class UniversalSimilarity {
    constructor(options) {
      this.baseUrl = String(options.baseUrl || "").replace(/\/$/, "");
      this.asset = options.asset;
      this.json = options.json;
      this.transport = options.transport;
      this.registry = options.registry;
      this.executionProviders = options.executionProviders || null;
      this.loadedPromise = null;
      this.sessionsPromise = null;
      this.queryPromises = new Map();
    }

    async descriptor() {
      const registry = await this.registry();
      if (!registry.universalCorpus) {
        throw new Error("The universal visual corpus is not published yet");
      }
      return registry.universalCorpus;
    }

    async load() {
      if (!this.loadedPromise) {
        this.loadedPromise = (async () => {
          const descriptor = await this.descriptor();
          const manifest = await this.json(
            descriptor.manifest, descriptor.manifestSha256,
          );
          const prefix = descriptor.manifest.includes("/")
            ? descriptor.manifest.replace(/\/[^/]+$/, "")
            : "";
          const assetPath = (file) => (prefix ? `${prefix}/${file}` : file);
          const read = async (name) => {
            const item = manifest.assets[name];
            return this.asset(assetPath(item.file), item.sha256);
          };
          const [coreBuffer, meanBuffer, eigenvectorBuffer, scaleBuffer,
            rotationBuffer, biasBuffer, centroidBuffer, codeBuffer, indexBuffer] =
            await Promise.all([
              read("core"), read("mean"), read("eigenvectors"), read("scales"),
              read("opqRotation"), read("opqBias"), read("centroids"),
              read("codes"), read("indices"),
            ]);
          const coreText = await UniversalSimilarity.gunzipText(coreBuffer);
          const core = JSON.parse(coreText);
          const loaded = {
            descriptor, manifest, prefix, core,
            mean: floatArray(meanBuffer),
            eigenvectors: floatArray(eigenvectorBuffer),
            scales: floatArray(scaleBuffer),
            rotation: floatArray(rotationBuffer),
            bias: floatArray(biasBuffer),
            centroids: floatArray(centroidBuffer),
            codes: new Uint8Array(codeBuffer),
            mapIndices: intArray(indexBuffer),
          };
          this.validate(loaded);
          return loaded;
        })().catch((error) => {
          this.loadedPromise = null;
          throw error;
        });
      }
      return this.loadedPromise;
    }

    static async gunzipText(buffer) {
      if (typeof DecompressionStream !== "function") {
        throw new Error("This browser cannot decompress the universal corpus");
      }
      const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
      return textDecoder.decode(await new Response(stream).arrayBuffer());
    }

    validate(data) {
      const dimensions = data.manifest.query.dimensions;
      const rows = data.manifest.corpus.rows;
      const subquantizers = data.manifest.opq.subquantizers;
      const subdimensions = data.manifest.opq.subvectorDimensions;
      if (data.mean.length !== dimensions || data.scales.length !== dimensions
          || data.eigenvectors.length !== dimensions * dimensions
          || data.rotation.length !== dimensions * dimensions
          || data.bias.length !== dimensions) {
        throw new Error("Universal transform dimensions are inconsistent");
      }
      if (data.centroids.length !== subquantizers * 256 * subdimensions
          || data.codes.length !== rows * subquantizers
          || data.mapIndices.length !== rows) {
        throw new Error("Universal OPQ dimensions are inconsistent");
      }
      if (!Array.isArray(data.core.panoramas)
          || data.core.panoramas.length !== data.manifest.corpus.coreRows) {
        throw new Error("Universal panorama metadata is inconsistent");
      }
    }

    async sessions() {
      if (!this.sessionsPromise) {
        this.sessionsPromise = (async () => {
          const data = await this.load();
          const ort = root.ort;
          if (!ort?.InferenceSession) {
            throw new Error("The browser vision runtime did not load");
          }
          if (ort.env?.wasm) {
            ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/";
            // GeoGuessr is not cross-origin isolated, so browser WASM cannot
            // use shared-memory threads. Be explicit and avoid a failed
            // multi-thread initialization before the single-thread fallback.
            ort.env.wasm.numThreads = 1;
          }
          const chromium = /(?:Chrome|Chromium|CriOS|Edg|OPR)\//.test(navigator.userAgent);
          const providers = this.executionProviders
            || (navigator.gpu && chromium ? ["webgpu"] : ["wasm"]);
          const models = data.manifest.query.models;
          const loadModel = async (description) => {
            const path = data.prefix ? `${data.prefix}/${description.file}` : description.file;
            try {
              const buffer = await this.asset(path, description.sha256 || description.file);
              return await ort.InferenceSession.create(new Uint8Array(buffer), {
                executionProviders: providers, graphOptimizationLevel: "all",
              });
            } catch (error) {
              throw new Error(`Universal model failed to load: ${description.file} (${String(error)})`);
            }
          };
          // Compile one graph at a time. Concurrent WebGPU compilation causes
          // a much larger transient spike beside an active Street View round.
          const dino2 = await loadModel(models.dino2);
          const dino3 = await loadModel(models.dino3);
          return { dino2, dino3, providers };
        })().catch((error) => {
          this.sessionsPromise = null;
          throw error;
        });
      }
      return this.sessionsPromise;
    }

    async prewarm() {
      await this.load();
      return this.sessions();
    }

    queryKey(panoId, headings, count) {
      return `${panoId}:${headings.join(",")}:${count}`;
    }

    async query(panoId, headings = [0, 90, 180, 270], count = 500) {
      if (!panoId) throw new Error("A panorama ID is required for universal visual search");
      const normalizedHeadings = headings.slice(0, 4).map((value) => (
        ((Math.round(Number(value) || 0) % 360) + 360) % 360
      ));
      while (normalizedHeadings.length < 4) {
        normalizedHeadings.push((normalizedHeadings[0] + normalizedHeadings.length * 90) % 360);
      }
      const key = this.queryKey(panoId, normalizedHeadings, count);
      if (!this.queryPromises.has(key)) {
        this.queryPromises.set(key, this.computeQuery(
          panoId, normalizedHeadings, count,
        ).catch((error) => {
          this.queryPromises.delete(key);
          throw error;
        }));
      }
      return this.queryPromises.get(key);
    }

    async fetchBitmaps(panoId, headings) {
      const urls = headings.map((heading) => thumbnail(panoId, heading));
      const buffers = await Promise.all(urls.map((url) => this.transport(url)));
      const bitmaps = await Promise.all(buffers.map((buffer) => (
        createImageBitmap(new Blob([buffer], { type: "image/jpeg" }))
      )));
      return { urls, bitmaps };
    }

    preprocess(bitmaps, width, height, mean, std) {
      const plane = width * height;
      const output = new Float32Array(4 * 3 * plane);
      const canvas = typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement("canvas"), { width, height });
      const context = canvas.getContext("2d", { willReadFrequently: true });
      bitmaps.forEach((bitmap, image) => {
        context.clearRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        const rgba = context.getImageData(0, 0, width, height).data;
        for (let pixel = 0; pixel < plane; pixel += 1) {
          for (let channel = 0; channel < 3; channel += 1) {
            output[(image * 3 + channel) * plane + pixel] = (
              rgba[pixel * 4 + channel] / 255 - mean[channel]
            ) / std[channel];
          }
        }
      });
      return output;
    }

    async embed(panoId, headings) {
      const [data, sessions, images] = await Promise.all([
        this.load(), this.sessions(), this.fetchBitmaps(panoId, headings),
      ]);
      const { normalizationMean: mean, normalizationStd: std, models } = data.manifest.query;
      try {
        const dino2Input = this.preprocess(
          images.bitmaps, models.dino2.inputWidth, models.dino2.inputHeight, mean, std,
        );
        const dino3Input = this.preprocess(
          images.bitmaps, models.dino3.inputWidth, models.dino3.inputHeight, mean, std,
        );
        const ort = root.ort;
        // Keep the large WebGPU graphs serialized. Running both sessions at
        // once can exceed the browser's transient device-memory budget.
        const dino2Result = await sessions.dino2.run({ views: new ort.Tensor(
          "float32", dino2Input, [4, 3, models.dino2.inputHeight, models.dino2.inputWidth],
        ) });
        const dino2 = unit(dino2Result.embedding.data);
        dino2Result.embedding.dispose?.();
        const dino3Result = await sessions.dino3.run({ views: new ort.Tensor(
          "float32", dino3Input, [4, 3, models.dino3.inputHeight, models.dino3.inputWidth],
        ) });
        const dino3 = unit(dino3Result.embedding.data);
        dino3Result.embedding.dispose?.();
        const raw = new Float32Array(data.manifest.query.dimensions);
        const dino2Scale = Math.sqrt(data.manifest.query.dino2Weight);
        const dino3Scale = Math.sqrt(data.manifest.query.dino3Weight);
        for (let index = 0; index < dino2.length; index += 1) {
          raw[index] = dino2Scale * dino2[index];
          raw[dino2.length + index] = dino3Scale * dino3[index];
        }
        return {
          vector: unit(raw),
          viewUrls: images.urls,
          executionProvider: sessions.providers[0],
        };
      } finally {
        images.bitmaps.forEach((bitmap) => bitmap.close());
      }
    }

    transform(raw, data) {
      const dimensions = data.manifest.query.dimensions;
      const projected = new Float32Array(dimensions);
      for (let source = 0; source < dimensions; source += 1) {
        const value = raw[source] - data.mean[source];
        const offset = source * dimensions;
        for (let target = 0; target < dimensions; target += 1) {
          projected[target] += value * data.eigenvectors[offset + target];
        }
      }
      const removed = data.manifest.transform.removedTopComponents;
      for (let target = 0; target < dimensions; target += 1) {
        projected[target] = target < removed ? 0 : projected[target] * data.scales[target];
      }
      const normalized = unit(projected);
      const rotated = new Float32Array(dimensions);
      for (let target = 0; target < dimensions; target += 1) {
        let value = data.bias[target];
        const offset = target * dimensions;
        for (let source = 0; source < dimensions; source += 1) {
          value += normalized[source] * data.rotation[offset + source];
        }
        rotated[target] = value;
      }
      return rotated;
    }

    search(rotated, data, count = 500) {
      const { rows } = data.manifest.corpus;
      const { subquantizers, subvectorDimensions } = data.manifest.opq;
      const table = new Float32Array(subquantizers * 256);
      for (let sub = 0; sub < subquantizers; sub += 1) {
        const queryOffset = sub * subvectorDimensions;
        for (let centroid = 0; centroid < 256; centroid += 1) {
          let score = 0;
          const centroidOffset = (sub * 256 + centroid) * subvectorDimensions;
          for (let dimension = 0; dimension < subvectorDimensions; dimension += 1) {
            score += rotated[queryOffset + dimension]
              * data.centroids[centroidOffset + dimension];
          }
          table[sub * 256 + centroid] = score;
        }
      }
      const scores = new Float32Array(rows);
      for (let row = 0; row < rows; row += 1) {
        let score = 0;
        const offset = row * subquantizers;
        for (let sub = 0; sub < subquantizers; sub += 1) {
          score += table[sub * 256 + data.codes[offset + sub]];
        }
        scores[row] = score;
      }
      return topKHeap(scores, count);
    }

    async computeQuery(panoId, headings, count) {
      const started = performance.now();
      const [data, embedded] = await Promise.all([this.load(), this.embed(panoId, headings)]);
      const inferenceDone = performance.now();
      const rotated = this.transform(embedded.vector, data);
      const transformedDone = performance.now();
      const matches = this.search(rotated, data, count).map((match, rank) => {
        const mapIndex = data.mapIndices[match.row];
        const panorama = data.core.panoramas[mapIndex];
        return {
          row: match.row, mapIndex, rank: rank + 1, similarity: match.score,
          panoId: panorama.p, latitude: panorama.a, longitude: panorama.o,
          headings: panorama.h,
        };
      });
      return {
        corpusId: data.manifest.corpus.id,
        corpusLabel: data.manifest.corpus.label,
        panoId, headings, viewUrls: embedded.viewUrls, rotated, matches,
        timing: {
          inferenceMs: inferenceDone - started,
          transformMs: transformedDone - inferenceDone,
          searchMs: performance.now() - transformedDone,
        },
        executionProvider: embedded.executionProvider,
      };
    }

    static thumbnail(...args) {
      return thumbnail(...args);
    }

    static unit(values) {
      return unit(values);
    }

    static topKHeap(values, count) {
      return topKHeap(values, count);
    }
  }

  root.OMTUniversalSimilarity = UniversalSimilarity;
  if (typeof module !== "undefined" && module.exports) module.exports = UniversalSimilarity;
})(typeof globalThis !== "undefined" ? globalThis : this);
