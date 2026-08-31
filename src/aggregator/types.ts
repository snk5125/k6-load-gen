/**
 * Shared output shape for every aggregator renderer (Vector, Cribl, ...).
 * A renderer returns the file's name and its exact contents; the CLI
 * (a later task) decides where under `aggregator-configs/` it lands.
 */
export interface RenderedConfig {
  filename: string;
  content: string;
}
