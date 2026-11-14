// js-yaml ships without types (it comes with electron-builder); the tests only parse.
declare module "js-yaml" {
  const yaml: { load(text: string): unknown };
  export default yaml;
}
