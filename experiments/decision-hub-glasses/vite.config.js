import { defineConfig } from "vite";

// Das Handy erreicht kein localhost — HMR muss auf die LAN-Adresse zeigen,
// sonst laedt das Plugin einmal und friert dann ein.
export default defineConfig({
  server: {
    host: true,
    port: 5173,
    hmr: { host: "192.168.178.48" },
  },
});
