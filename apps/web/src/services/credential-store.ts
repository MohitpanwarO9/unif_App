
import { invoke } from "@tauri-apps/api/core";

const isTauri = () =>
  typeof window !== "undefined" &&
  "__TAURI_INTERNALS__" in window;

export const credentialStore = {
  async set(key: string, value: string): Promise<void> {
    if (!isTauri()) {
      throw new Error("Secure storage is available only in the desktop app.");
    }

    await invoke("credential_store_set", { key, value });
  },

  async get(key: string): Promise<string | null> {
    if (!isTauri()) {
      throw new Error("Secure storage is available only in the desktop app.");
    }

    return await invoke<string | null>("credential_store_get", { key });
  },

  async delete(key: string): Promise<void> {
    if (!isTauri()) {
      throw new Error("Secure storage is available only in the desktop app.");
    }

    await invoke("credential_store_delete", { key });
  },
};
