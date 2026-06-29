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
 * Writes a YAML file and creates parent directories when needed.
 */
function writeYaml(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(cleanEmpty(data)));
}

/**
 * Removes empty objects and arrays.
 */
function cleanEmpty(value) {
  if (Array.isArray(value)) return value.map(cleanEmpty);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, child]) => [key, cleanEmpty(child)])
      .filter(([, child]) => !child || Object.keys(child).length > 0)
  );
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
function merge(base, overlay) {
  if (overlay === null) return undefined;
  if (Array.isArray(base) && Array.isArray(overlay)) {
    if (base.some(item => item?.name && item?.in) 
       || overlay.some(item => item?.name && item?.in) 
       ) return mergeParameters(base, overlay);
    return overlay;
  }
  if (isObject(base) && isObject(overlay)) {
    if (Array.isArray(base.oneOf) && base.oneOf.length === 2 && base.oneOf.some(item => isObject(item) && item.type === "null")) return mergeNullableOneOf(base, overlay);
    if (Array.isArray(base.allOf) && Object.keys(overlay).some(key => key !== "allOf" && key !== "oneOf" && key !== "anyOf")) return mergeObjectSchemaMembersIntoAllOf(base, overlay);
    const result = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
      const merged = merge(result[key], value);
      if (merged === undefined) delete result[key];
      else result[key] = merged;
    }
    return result;
  }
  return overlay;
}

/** 
 * Merges OpenAPI parameter arrays.
 *
 * Parameters are matched by `name` and `in`
 * A parameter overlay with _delete: true removes the matching parameter.
 */
function mergeParameters(base, overlay) {
  const result = [...base];
  for (const parameter of overlay) {
    const index = result.findIndex(existing =>
      existing?.name === parameter?.name &&
      existing?.in === parameter?.in
    );
    if (parameter?._delete === true) {
      if (index >= 0) result.splice(index, 1);
    } else if (index >= 0) result[index] = merge(result[index], parameter);
      else result.push(parameter);
  }
  return result;
}

/** comment missing */
function mergeObjectSchemaMembersIntoAllOf(base, overlay) {
  const result = { ...base, allOf: [...base.allOf] };
  const objectOverlay = {};
  const rootOverlay = {};
  for (const [key, value] of Object.entries(overlay)) {
    if (key !== "allOf" && key !== "oneOf" && key !== "anyOf") objectOverlay[key] = value;
    else rootOverlay[key] = value;
  }
  let index = result.allOf.findIndex(item => isObject(item) && !item.$ref && (item.type === "object" || isObject(item.properties) || Array.isArray(item.required)));
  if (index < 0) {
    index = result.allOf.length;
    result.allOf.push({ type: "object" });
  }
  const mergedObject = merge(result.allOf[index], { type: "object", ...objectOverlay });
  if (mergedObject === undefined) result.allOf.splice(index, 1);
  else result.allOf[index] = mergedObject;
  return merge(result, rootOverlay);
}

/**
 * Merges an overlay into a nullable oneOf schema.
 */
function mergeNullableOneOf(base, overlay) {
  if (isObject(overlay) && Array.isArray(overlay.oneOf) && overlay.oneOf.length === 2 && overlay.oneOf.some(item => isObject(item) && item.type === "null")) {
    const baseSchema = base.oneOf.find(item => !(isObject(item) && item.type === "null"));
    const overlaySchema = overlay.oneOf.find(item => !(isObject(item) && item.type === "null"));
    const nullSchema = overlay.oneOf.find(item => isObject(item) && item.type === "null") ?? base.oneOf.find(item => isObject(item) && item.type === "null");
    return { ...base, ...overlay, oneOf: [mergeOneOfSchema(baseSchema, overlaySchema), nullSchema] };
  }
  if (isObject(overlay) && !Array.isArray(overlay.oneOf)) {
    const baseSchema = base.oneOf.find(item => !(isObject(item) && item.type === "null"));
    const nullSchema = base.oneOf.find(item => isObject(item) && item.type === "null");
    return { ...base, oneOf: [mergeOneOfSchema(baseSchema, overlay), nullSchema] };
  }
  return overlay;
}

/**
 * Merges the non-null branch of a nullable oneOf schema.
 */
function mergeOneOfSchema(base, overlay) {
  if (isObject(overlay) && (Array.isArray(overlay.allOf) || Array.isArray(overlay.oneOf) || Array.isArray(overlay.anyOf))) return overlay;
  if (isObject(base) && base.$ref && isObject(overlay)) return { allOf: [base, { type: "object", ...overlay }] };
  return merge(base, overlay);
}

/**
 * Determines whether a value is a plain object.
 */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  const overlay = readYaml(overlayFile);
  if (!fs.existsSync(targetFile)) {         // If the file is new, add it to generated/.
    console.log(`Adding new file ${relativeFile}`);
    writeYaml(targetFile, overlay);
  } else {                                  // If the file already exists, merge the overlay into the generated file.
    const base = readYaml(targetFile);
    const merged = merge(base, overlay);
    console.log(`Merging file ${relativeFile}`);
    writeYaml(targetFile, merged);
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
const generatedSpec = readYaml(generatedSpecFile);
generatedSpec.info ??= {};
generatedSpec.info["x-profile-name"] = profile.profileName;
generatedSpec.info["x-profile-version"] = profile.profileVersion;
generatedSpec.info["x-oeapi-min-versions"] = profile.oeapi.oeapiMinVersions ?? [];
generatedSpec.info["x-consumers"] = profile.consumers ?? [];
console.log(`Adding info to ${generatedSpecFile}`);
writeYaml(generatedSpecFile, generatedSpec);
console.log(`Specification tree written to ${generatedDir}.`);
