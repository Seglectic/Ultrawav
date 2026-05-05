import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react()],
  lint: { options: { typeAware: true, typeCheck: true } },
});
