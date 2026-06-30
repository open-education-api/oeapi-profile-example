#!/usr/bin/env node

/**
 * OEAPI overlay merger.
 *
 * Usage:
 *   node overlay-merger.js profile-example
 *
 * The argument is the profile directory.
 *
 * Expected directory structure:
 *
 * profile-example/
 * ├── profile.yaml
 * ├── source/
 * │   ├── spec.yaml
 * │   ├── paths/
 * │   ├── schemas/
 * │   └── consumers/
 * │       └── consumer-example/
 * └── generated/
 *
 * Expected profile.yaml:
 *
 * profileName: profile-example
 * profileVersion: v1.0.0
 * oeapi:
 *   oeapiPath: ../base/oeapi
 *   oeapiMinVersions:
 *     - v6.1
 *     - v7.0
 * consumers:
 *   - consumer-example:
 *       path: source/consumers/consumer-example
 *
 * Merge rules:
 *
 * - the OEAPI base source tree is copied from oeapi.path/source to generated/;
 * - profile overlay files from source/ are merged into generated/;
 * - new files that only exist in source/ are added to generated/;
 * - null removes an object member;
 * - objects are merged recursively;
 * - scalars replace the base value;
 * - parameters are merged by name and in;
 * - _delete: true removes a matching parameter;
 * - other arrays replace the base array.
 */

/**
 * Reads a YAML file.
 *
 * The file may be a complete OpenAPI file, an overlay fragment or a profile.yaml file.
 */
function readYaml(file) {
//  console.log(`Reading profile metadata from ${file} - ${process.cwd()}`);
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}.`);
  return YAML.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Reads a YAML file as document so comments and scalar style are preserved.
 */
function readYamlDocument(file) {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}.`);
  return YAML.parseDocument(fs.readFileSync(file, "utf8"), { keepSourceTokens: true });
}

/**
 * Writes a YAML document and creates parent directories when needed.
 */
function writeYamlDocument(file, document) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(document));
}

/**
 * Merges an overlay value into a base value.
 *
 * Merge rules:
 *
 * null
 *   removes an object member
 *
 * object + object
 *   merges recursively
 *
 * scalar + scalar
 *   the overlay value takes precedence
 *
 * parameter array + parameter array
 *   merges by name and in
 *
 * other arrays
 *   the overlay array replaces the base array
 */
function merge(base, overlay, document) {
  if (overlay === undefined || overlay === null || overlay.value === null) return undefined;
  if (YAML.isSeq(base) && YAML.isSeq(overlay)) {
    if (base.items.some(item => YAML.isMap(item) && item.has("name") && item.has("in"))
       || overlay.items.some(item => YAML.isMap(item) && item.has("name") && item.has("in"))
       ) return mergeParameters(base, overlay, document);
    base.items = overlay.items;
    return base;
  }
  if (YAML.isMap(base) && YAML.isMap(overlay)) {
    const oneOf = base.get("oneOf", true);
    const allOf = base.get("allOf", true);
    if (YAML.isSeq(oneOf) && oneOf.items.length === 2 && oneOf.items.some(item => YAML.isMap(item) && item.get("type") === "null")) return mergeNullableOneOf(base, overlay, document);
    if (YAML.isSeq(allOf) && overlay.items.some(item => !["allOf", "oneOf", "anyOf"].includes(item.key.value))) return mergeObjectSchemaMembersIntoAllOf(base, overlay, document);
    for (const item of overlay.items) {
      const key = item.key.value;
      const merged = merge(base.get(key, true), item.value, document);
      if (merged === undefined) base.delete(key);
      else base.set(key, merged);
    }
    return base;
  }
  return overlay;
}

/** 
 * Merges OpenAPI parameter arrays.
 *
 * Parameters are matched by `name` and `in`
 * A parameter overlay with _delete: true removes the matching parameter.
 */
function mergeParameters(base, overlay, document) {
  for (const parameter of overlay.items) {
    const index = base.items.findIndex(existing =>
      YAML.isMap(existing) && YAML.isMap(parameter) &&
      existing.get("name") === parameter.get("name") &&
      existing.get("in") === parameter.get("in")
    );
    if (YAML.isMap(parameter) && parameter.get("_delete") === true) {
      if (index >= 0) base.items.splice(index, 1);
    } else if (index >= 0) base.items[index] = merge(base.items[index], parameter, document);
      else base.items.push(parameter);
  }
  return base;
}

/** comment missing */
function mergeObjectSchemaMembersIntoAllOf(base, overlay, document) {
  const allOf = base.get("allOf", true);
  const objectOverlay = new YAML.YAMLMap();
  const rootOverlay = new YAML.YAMLMap();
  for (const item of overlay.items) {
    if (!["allOf", "oneOf", "anyOf"].includes(item.key.value)) objectOverlay.items.push(item);
    else rootOverlay.items.push(item);
  }
  if (!objectOverlay.has("type")) objectOverlay.set("type", "object");
  let index = allOf.items.findIndex(item => YAML.isMap(item) && !item.has("$ref") && (item.get("type") === "object" || YAML.isMap(item.get("properties", true)) || YAML.isSeq(item.get("required", true))));
  if (index < 0) {
    index = allOf.items.length;
    allOf.items.push(document.createNode({ type: "object" }));
  }
  const mergedObject = merge(allOf.items[index], objectOverlay, document);
  if (mergedObject === undefined) allOf.items.splice(index, 1);
  else allOf.items[index] = mergedObject;
  return merge(base, rootOverlay, document);
}

/**
 * Merges an overlay into a nullable oneOf schema.
 */
function mergeNullableOneOf(base, overlay, document) {
  const baseOneOf = base.get("oneOf", true);
  const overlayOneOf = overlay.get("oneOf", true);
  if (YAML.isSeq(overlayOneOf) && overlayOneOf.items.length === 2 && overlayOneOf.items.some(item => YAML.isMap(item) && item.get("type") === "null")) {
    const baseSchema = baseOneOf.items.find(item => !(YAML.isMap(item) && item.get("type") === "null"));
    const overlaySchema = overlayOneOf.items.find(item => !(YAML.isMap(item) && item.get("type") === "null"));
    const nullSchema = overlayOneOf.items.find(item => YAML.isMap(item) && item.get("type") === "null") ?? baseOneOf.items.find(item => YAML.isMap(item) && item.get("type") === "null");
    for (const item of overlay.items) {
      if (item.key.value !== "oneOf") base.set(item.key.value, item.value);
    }
    baseOneOf.items = [mergeOneOfSchema(baseSchema, overlaySchema, document), nullSchema];
    return base;
  }
  if (!YAML.isSeq(overlayOneOf)) {
    const baseSchema = baseOneOf.items.find(item => !(YAML.isMap(item) && item.get("type") === "null"));
    const nullSchema = baseOneOf.items.find(item => YAML.isMap(item) && item.get("type") === "null");
    baseOneOf.items = [mergeOneOfSchema(baseSchema, overlay, document), nullSchema];
    return base;
  }
  return overlay;
}

/**
 * Merges the non-null branch of a nullable oneOf schema.
 */
function mergeOneOfSchema(base, overlay, document) {
  if (YAML.isMap(overlay) && (YAML.isSeq(overlay.get("allOf", true)) || YAML.isSeq(overlay.get("oneOf", true)) || YAML.isSeq(overlay.get("anyOf", true)))) return overlay;
  if (YAML.isMap(base) && base.has("$ref") && YAML.isMap(overlay)) {
    const objectOverlay = new YAML.YAMLMap();
    const result = new YAML.YAMLMap();
    const allOf = new YAML.YAMLSeq();
    objectOverlay.set("type", "object");
    for (const item of overlay.items) objectOverlay.items.push(item);
    allOf.items.push(base, objectOverlay);
    result.set("allOf", allOf);
    return result;
  }
  return merge(base, overlay, document);
}

const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

/**
 * The first command-line argument is the profile directory.
 */
const profileDir = process.argv[2];

if (!profileDir) {
  console.error("Usage: node overlay-merger.js <profile-directory>");
  process.exit(1);
}

/**
 * Fixed locations inside the profile directory.
 */
const profileFile = path.join(profileDir, "profile.yaml");
const profileSourceDir = path.join(profileDir, "source");
const generatedDir = path.join(profileDir, "generated");

/**
 * Read the profile metadata.
 */
const profile = readYaml(profileFile);

/**
 * The OEAPI base path is read from profile.yaml.
 * It is resolved relative to the profile directory.
 */
if (!profile.oeapi?.oeapiPath) throw new Error("profile.yaml must contain oeapi.oeapiPath.");
const oeapiDir = path.join(path.resolve(profileDir, profile.oeapi.oeapiPath), "source");

/**
 * Recreate generated/ from scratch and start with a complete copy of the OEAPI base source tree.
 *
 * This prevents old generated files from remaining in the output.
 */
if (fs.existsSync(generatedDir)) fs.rmSync(generatedDir, { recursive: true, force: true });
fs.cpSync(oeapiDir, generatedDir, { recursive: true });

/**
 * Apply all overlay files from profile-example/source to generated/.
 *
 * This is a file-tree overlay:
 *
 * profile-example/source/schemas/Course.yaml
 *   is applied to:
 * profile-example/generated/schemas/Course.yaml
 *
 * If the target file does not exist yet, the overlay file is added as a new
 * generated file.
 */
for (const relativeFile of fs.globSync("**/*.{yaml,yml}", { cwd: profileSourceDir })) {
  const overlayFile = path.join(profileSourceDir, relativeFile);
  const targetFile = path.join(generatedDir, relativeFile);
  if (!fs.existsSync(targetFile)) {         // If the file is new, add it to generated/.
    console.log(`Adding new file ${relativeFile}`);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.copyFileSync(overlayFile, targetFile);
  } else {                                  // If the file already exists, merge the overlay into the generated file.
    const overlay = readYamlDocument(overlayFile);
    const target = readYamlDocument(targetFile);
    merge(target.contents, overlay.contents, target);
    console.log(`Merging file ${relativeFile}`);
    writeYamlDocument(targetFile, target);
  }
}

/**
 * Add profile metadata to the generated spec.yaml.
 *
 * This is done after applying overlays, so profile metadata always ends up in
 * the generated specification, even when source/spec.yaml also contains
 * profile-specific metadata.
 */
const generatedSpecFile = path.join(generatedDir, "spec.yaml");
const generatedSpec = readYamlDocument(generatedSpecFile);
let info = generatedSpec.contents.get("info", true);
if (!YAML.isMap(info)) {
  info = new YAML.YAMLMap();
  generatedSpec.contents.set("info", info);
}
info.set("x-profile", generatedSpec.createNode({
  profileName: profile.profileName,
  profileVersion: profile.profileVersion,
  oeapiMinVersions: profile.oeapi.oeapiMinVersions ?? [],
  consumers: (profile.consumers ?? []).map(consumer =>
    readYaml(path.join(profileDir, consumer.path, "consumer.yaml"))
  )
}));
console.log(`Adding info to ${generatedSpecFile}`);
writeYamlDocument(generatedSpecFile, generatedSpec);
console.log(`Specification tree written to ${generatedDir}.`);
