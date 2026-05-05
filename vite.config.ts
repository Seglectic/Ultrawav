import react from "@vitejs/plugin-react";
import AutoImport from "unplugin-auto-import/vite";
import IconsResolver from "unplugin-icons/resolver";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    react(),
    AutoImport({
      dts: "src/auto-imports.d.ts",
      resolvers: [
        IconsResolver({
          prefix: "Icon",
          extension: "jsx",
        }),
      ],
    }),
    Icons({ compiler: "jsx", jsx: "react" }),
  ],
  lint: { options: { typeAware: true, typeCheck: true } },
});
