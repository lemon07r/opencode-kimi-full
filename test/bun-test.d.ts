declare module "bun:test" {
  export const test: (...args: any[]) => any
  export const expect: any
  export const afterEach: (...args: any[]) => any
}
