declare module "@blockingmachine/core" {
  export interface FilterListMetadata {
    title?: string;
    description?: string;
    homepage?: string;
    version?: string;
    lastUpdated?: string;
    [key: string]: any;
  }

  export const defaultFilterMeta: FilterListMetadata;
  export function createPaths(baseDir: string): any;
  export const defaultPerformance: {
    processing: any;
    [key: string]: any;
  };

  export function exportWithOptions(
    outputPath: string,
    meta: FilterListMetadata,
    options: any,
  ): Promise<any>;
}
