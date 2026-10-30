<script lang="ts" setup>
import { computed, h, inject, ref } from "vue";
import { useI18n } from "vue-i18n";

import { filesize } from "filesize";
import { get, set } from "@vueuse/core";
import type { CampaignType } from "scnexus-standard/metadata";
import { KEY_FILEPATH, KEY_CFI } from "../symbol";

import { emitterEmit } from "@/composables/useMitt";
import { ipcCampaign } from "@/apis/ipcs/campaign";
import { ipcCustomize } from "@/apis/ipcs/customize";
import { useNotification } from "naive-ui";

const { t } = useI18n();
const notification = useNotification();

const refModal = ref();
const showModal = ref(false);
const operationLoading = ref(false);

const cfi = inject(KEY_CFI);
const metadata = computed(() =>
  get(cfi)?.metadata?.manager === "SCNexus"
    ? get(cfi)?.metadata
    : get(cfi)?.ccm?.metadata
);
// Plain 包：压缩包内没有任何元数据，按文件名安装，战役归属由用户选择。
const isPlain = computed(() => !!get(cfi)?.ccm?.plain);
const campaignOptions = [
  { label: () => t("customize.drop-zone.process-dialog.campaign-wol"), value: "WOL" },
  { label: () => t("customize.drop-zone.process-dialog.campaign-hots"), value: "HOTS" },
  { label: () => t("customize.drop-zone.process-dialog.campaign-lotv"), value: "LOTV" },
  { label: () => t("customize.drop-zone.process-dialog.campaign-nco"), value: "NCO" },
];
const selectedCampaign = ref<CampaignType>("WOL");
const file_path = inject(KEY_FILEPATH);

const onContinuProcess = async () => {
  set(operationLoading, true);
  const vPath = get(file_path);
  const vCfi = get(cfi);
  const vMetadata = get(metadata);

  // 用 try/catch/finally 兜底：即使后台调用异常或 Promise 被拒绝，
  // 也要结束加载状态并关闭弹窗，避免界面永久转圈。
  try {
    let result = false;
    if (vMetadata?.manager === "SCNexus") {
      const { data, error } = await ipcCustomize.installCompressFile7z(vPath!);
      if (error) {
        console.error(error);
      }
      if (data) {
        result = true;
      }
    } else if (vMetadata?.manager === "CCM") {
      // Plain 包时附带用户选择的战役归属，后台按文件名降级安装。
      const { data, error } = await ipcCampaign.unzipCompressFile7zSimulateCCM(
        vPath!,
        get(isPlain) ? get(selectedCampaign) : undefined
      );
      if (error) {
        console.error(error);
      }
      if (data) {
        result = true;
      }
    }
    if (result) {
      emitterEmit("customize-file-unzipped");
      notification.info({
        title:
          t("customize.drop-zone.process-dialog.message-success-title") +
          vMetadata?.name,
        content: () =>
          h("div", { class: "flex flex-col gap-1" }, [
            h(
              "div",
              undefined,
              t("customize.drop-zone.process-dialog.message-success-content", {
                count: vCfi!.compress_info.files_count,
              })
            ),
            h(
              "div",
              undefined,
              "共计占用磁盘空间 " +
                filesize(vCfi!.compress_info.size, { standard: "jedec" })
            ),
          ]),
        duration: 3000,
      });
    }
  } catch (error) {
    console.error(error);
  } finally {
    set(operationLoading, false);
  }
};

const open = () => {
  // Plain 包默认选中包内路径推断出的战役（没有推断结果时保持 WOL）。
  const inferred = get(cfi)?.ccm?.metadata?.campaign;
  if (inferred) {
    set(selectedCampaign, inferred);
  }
  set(showModal, true);
};

const close = () => {
  set(showModal, false);
};

defineExpose({ open });
</script>
<template>
  <n-modal
    ref="refModal"
    v-model:show="showModal"
    preset="dialog"
    :negativeText="t('customize.drop-zone.process-dialog.negative-text')"
    :positiveText="t('customize.drop-zone.process-dialog.positive-text')"
    :loading="operationLoading"
    :onPositiveClick="onContinuProcess"
  >
    <template #header>
      <div v-if="metadata?.type === 'Customize'">
        {{
          t("customize.drop-zone.process-dialog.title-customize") +
          metadata.name
        }}
      </div>
      <div v-else-if="metadata?.type === 'Campaign'">
        {{
          t("customize.drop-zone.process-dialog.title-campaign") + metadata.name
        }}
      </div>
    </template>
    <div class="flex flex-col gap-1">
      <div v-if="isPlain" class="flex flex-col gap-1 cell-normal">
        <div>
          {{ t("customize.drop-zone.process-dialog.plain-tip") }}
        </div>
        <n-select
          v-model:value="selectedCampaign"
          :options="campaignOptions"
        />
      </div>
      <div class="flex flex-col gap-1 cell-normal">
        <div>
          {{
            t("customize.drop-zone.process-dialog.description-author") +
            metadata?.author
          }}
        </div>
        <div>
          {{
            t("customize.drop-zone.process-dialog.description-version") +
            metadata?.version
          }}
        </div>
        <div>
          {{
            t("customize.drop-zone.process-dialog.description-description") +
            metadata?.description
          }}
        </div>
        <div>
          {{
            "共计：" +
            cfi!.compress_info.files_count +
            "个文件" +
            " @ " +
            filesize(cfi!.compress_info.size, { standard: "jedec" })
          }}
        </div>
        <div>
          {{ t("customize.drop-zone.process-dialog.description-install") }}
        </div>
      </div>
    </div>
  </n-modal>
</template>
