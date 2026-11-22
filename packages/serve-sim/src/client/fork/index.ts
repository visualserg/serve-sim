// fork: what client.tsx takes from the fork. Upstream files reach fork code
// only through seams tagged `fork:` (`just seams` lists them); the Stream row
// is imported straight from ./stream-settings by its own seam.

export { installForkViewer } from "./viewer";
