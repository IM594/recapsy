// Allow importing CSS files
declare module '*.css' {
  const content: { [className: string]: string };
  export default content;
}

// Augment React's CSSProperties to allow for the -webkit-app-region property.
// This is used by Electron to create draggable regions.
declare module "react" {
  interface CSSProperties {
    WebkitAppRegion?: "drag" | "no-drag";
    '-webkit-app-region'?: 'drag' | 'no-drag';
  }
}

declare global {
  interface Window {
    recaply?: {
      env?: {
        homeDir?: string;
      };
    };
  }
}

export {};
