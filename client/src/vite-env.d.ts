/// <reference types="vite/client" />

// Типизация для импорта SVG как React-компонента
declare module '*.svg?react' {
  import * as React from 'react';
  const ReactComponent: React.FunctionComponent<React.SVGProps<SVGSVGElement>>;
  export default ReactComponent;
}
