import { join, resolve } from "node:path";
import { app, safeStorage } from "electron";
import { CLIENT_PRODUCT } from "./client-product";
import { startClientRuntime } from "./client-runtime";

if (CLIENT_PRODUCT.role !== "client" || CLIENT_PRODUCT.runtimeStatus !== "account-shell") {
  throw new Error("The Feitu client entry requires the reviewed account-shell composition.");
}

app.setName(CLIENT_PRODUCT.productName);
app.setPath("userData", join(app.getPath("appData"), CLIENT_PRODUCT.applicationId));
app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app
    .whenReady()
    .then(() =>
      startClientRuntime({
        apiOrigin: CLIENT_PRODUCT.defaultApiOrigin,
        userDataPath: app.getPath("userData"),
        rendererRoot: resolve(__dirname, "../renderer"),
        preloadPath: resolve(__dirname, "../preload/client-index.cjs"),
        secureStorage: {
          isEncryptionAvailable: () =>
            safeStorage.isEncryptionAvailable() &&
            (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
          encryptString: (value) => safeStorage.encryptString(value),
          decryptString: (value) => safeStorage.decryptString(value),
        },
      }),
    )
    .catch(() => app.exit(1));
}
