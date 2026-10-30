import { MetadataStandard } from "scnexus-standard/metadata";

import type { ResultUncompress } from "./customize.type";

export type ResultUncompressCCM = Omit<ResultUncompress, "metadata"> & {
  ccm: {
    metadata?: MetadataStandard;
    metadata_root?: string;
    /**
     * Plain package: no metadata inside, installed by the archive file name.
     */
    plain?: boolean;
  };
};
