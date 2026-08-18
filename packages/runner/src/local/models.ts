/**
 * Model registry and management for local inference.
 * Models are downloaded from HuggingFace and stored in ~/.valet/models/
 */

import { promises as fs } from "fs";
import * as path from "path";
import { homedir } from "os";

export interface ModelInfo {
  repo: string; // HuggingFace repo (user/repo format)
  file: string; // GGUF file name in the repo
  size: string; // Human-readable size
}

/**
 * Registry of available models with their HuggingFace locations.
 * All models are quantized GGUF format for CPU inference.
 */
export const MODEL_REGISTRY: Record<string, ModelInfo> = {
  "qwen2.5-0.5b": {
    repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
    file: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
    size: "491MB",
  },
  "qwen2.5-1.5b": {
    repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
    file: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    size: "1.1GB",
  },
  "qwen2.5-coder-1.5b": {
    repo: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF",
    file: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
    size: "1.1GB",
  },
  "llama3.2-1b": {
    repo: "bartowski/Llama-3.2-1B-Instruct-GGUF",
    file: "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
    size: "772MB",
  },
  "llama3.2-3b": {
    repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    size: "2.0GB",
  },
};

/**
 * Get the models directory path (~/.valet/models/).
 */
export function getModelsDir(): string {
  return path.join(homedir(), ".valet", "models");
}

/**
 * Resolve a model name to its local file path.
 * Returns the path if it exists, throws error if not found.
 */
export async function resolveModelPath(name: string): Promise<string> {
  const modelInfo = MODEL_REGISTRY[name];
  if (!modelInfo) {
    const available = Object.keys(MODEL_REGISTRY).join(", ");
    throw new Error(
      `Unknown model: ${name}\nAvailable models: ${available}\n\nRun: valet model pull ${name}`,
    );
  }

  const modelPath = path.join(getModelsDir(), modelInfo.file);
  try {
    await fs.access(modelPath);
    return modelPath;
  } catch {
    throw new Error(
      `Model not downloaded: ${name}\n\nRun: valet model pull ${name}`,
    );
  }
}

/**
 * List all downloaded models with their sizes.
 */
export async function listModels(): Promise<Array<{ name: string; path: string; size: string }>> {
  const modelsDir = getModelsDir();
  try {
    const files = await fs.readdir(modelsDir);
    const models: Array<{ name: string; path: string; size: string }> = [];

    for (const file of files) {
      const filePath = path.join(modelsDir, file);
      const stat = await fs.stat(filePath);
      if (stat.isFile() && file.endsWith(".gguf")) {
        // Try to find the model name from registry
        let modelName = "unknown";
        for (const [name, info] of Object.entries(MODEL_REGISTRY)) {
          if (info.file === file) {
            modelName = name;
            break;
          }
        }
        models.push({
          name: modelName,
          path: filePath,
          size: formatBytes(stat.size),
        });
      }
    }

    return models.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/**
 * Remove a downloaded model by name.
 */
export async function removeModel(name: string): Promise<void> {
  const modelInfo = MODEL_REGISTRY[name];
  if (!modelInfo) {
    throw new Error(`Unknown model: ${name}`);
  }

  const modelPath = path.join(getModelsDir(), modelInfo.file);
  try {
    await fs.unlink(modelPath);
    console.log(`✓ Removed model: ${name}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Model not found: ${name}`);
    }
    throw err;
  }
}

/**
 * Download a model from HuggingFace using huggingface-hub CLI.
 * Requires 'huggingface-hub' to be installed.
 */
export async function pullModel(name: string): Promise<void> {
  const modelInfo = MODEL_REGISTRY[name];
  if (!modelInfo) {
    const available = Object.keys(MODEL_REGISTRY).join(", ");
    throw new Error(`Unknown model: ${name}\nAvailable: ${available}`);
  }

  const modelsDir = getModelsDir();
  await fs.mkdir(modelsDir, { recursive: true });

  const modelPath = path.join(modelsDir, modelInfo.file);

  // Check if already exists
  try {
    await fs.access(modelPath);
    console.log(`✓ Model already downloaded: ${name}`);
    return;
  } catch {
    // Not found, proceed with download
  }

  console.log(`⏳ Downloading ${name} (${modelInfo.size})...`);
  console.log(`   From: ${modelInfo.repo}/${modelInfo.file}`);

  // Use huggingface_hub CLI if available, otherwise show instructions
  try {
    const { execSync } = await import("child_process");
    try {
      // Try using huggingface-hub Python module
      const command = `huggingface-cli download ${modelInfo.repo} ${modelInfo.file} --local-dir ${modelsDir} --local-dir-use-symlinks false`;
      console.log(`   Running: ${command}`);
      execSync(command, { stdio: "inherit" });
      console.log(`✓ Downloaded: ${name}`);
    } catch {
      // Fallback to wget/curl
      console.log(
        `\n⚠️  huggingface-cli not found. Installing huggingface-hub:\n`,
      );
      console.log(`  pip install huggingface-hub[cli]\n`);
      console.log(`  Or manually download from:\n`);
      console.log(
        `  https://huggingface.co/${modelInfo.repo}/blob/main/${modelInfo.file}\n`,
      );
      console.log(`  And save to: ${modelPath}\n`);
      throw new Error(
        "Download requires huggingface-hub. See instructions above.",
      );
    }
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Format bytes to human-readable size.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
