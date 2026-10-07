import { defineConfig, presetUno, presetIcons } from "unocss";
import transformerDirectives from "@unocss/transformer-directives";
import { icons as tablerIcons } from "@iconify-json/tabler";

export default defineConfig({
  shortcuts: [
    {
      "cell-normal": "py-1 px-2 border border-gray-200 border-solid rounded-2",
    },
    [/^cell-normal-(.*)$/, ([, c]) => `bg-${c} cell-normal`],
    {
      "cell-hoverable":
        "cell-normal hover:shadow hover:transition-shadow duration-300",
    },
  ],
  theme: {},
  presets: [
    presetUno(),
    presetIcons({
      // 显式传入图标集合。必须用函数形式（lazy loader）：presetIcons
      // 仅在集合为函数时才按 IconifyJSON 结构（{ icons: {...} }）解析；
      // 直接传对象会被当成 { [图标名]: SVG } 扁平映射，导致图标静默丢失。
      collections: {
        tabler: () => tablerIcons,
      },
    }),
  ],
  transformers: [transformerDirectives()],
  safelist: [
    ...[
      "#1D9BF0",
      "#616BE6",
      "#FB7299",
      "#F0D850",
      "#946CE6",
      "#DD3E22",
      "#B94334",
      "#000000",
    ]
      .map((i) => [`border-[${i}]`, `text-[${i}]`])
      .flat(),
  ],
});
