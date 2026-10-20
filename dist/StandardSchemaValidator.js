"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StandardSchemaValidator = void 0;
const objection_1 = require("objection");
const objection_2 = require("./objection.js");
const standardSchema_1 = require("./standardSchema.js");
// Validates each column with its own Standard Schema. Validating per column
// (instead of one object schema) makes patch validation free: only the given
// properties are validated and no `.partial()` copy of the schema is needed.
class StandardSchemaValidator extends objection_1.Validator {
    columns;
    // A constructor, not `static init()`: objection exports `Validator` wrapped in an
    // ES5 function that calls the built-in `init` directly, so a subclass's would never run.
    constructor({ columns }) {
        super();
        this.columns = columns;
    }
    validate({ model, json, options }) {
        const columns = this.columns;
        const opts = options;
        const patch = !!opts.patch;
        let output = json;
        let errors = null;
        for (let i = 0, l = columns.length; i < l; ++i) {
            const col = columns[i];
            const value = json[col.prop];
            let result;
            if (value === undefined) {
                // Stryker disable next-line ConditionalExpression,StringLiteral: the `optional` check only skips re-validating `undefined`.
                if (patch || col.generated || col.hasDefault || col.undefinedMode === 'optional') {
                    continue;
                }
                if (col.undefinedMode === 'required') {
                    errors = addError(errors, opts, col.prop, {
                        message: 'is required',
                        keyword: 'required',
                        params: { missingProperty: col.prop },
                    });
                    continue;
                }
                // The schema produces a default value (zod `.default()` etc.).
                result = (0, standardSchema_1.validateSync)(col.schema, undefined, col.prop);
            }
            else {
                result = (0, standardSchema_1.validateSync)(col.schema, value, col.prop);
            }
            if (result.issues) {
                for (const issue of result.issues) {
                    errors = addError(errors, opts, issuePath(col.prop, issue), {
                        message: issue.message,
                        keyword: col.schema['~standard'].vendor,
                        params: { issue },
                    });
                }
                continue;
            }
            // Stryker disable next-line ConditionalExpression: copying unchanged values too is slower but equivalent.
            if (result.value !== value) {
                // Schemas can transform values. Copy lazily so that the common case
                // of untransformed input allocates nothing.
                if (output === json && !opts.mutable) {
                    output = Object.assign({}, json);
                }
                output[col.prop] = result.value;
            }
        }
        if (errors !== null) {
            // SAFETY: objection only validates model instances, and a model's constructor is its class.
            throw model.constructor.createValidationError({
                type: objection_2.ValidationError.Type.ModelValidation,
                data: errors,
            });
        }
        return output;
    }
}
exports.StandardSchemaValidator = StandardSchemaValidator;
function issuePath(prop, issue) {
    // Stryker disable next-line ConditionalExpression: an empty path joins to just `prop` anyway.
    if (!issue.path || issue.path.length === 0) {
        return prop;
    }
    const segments = issue.path.map(it => (typeof it === 'object' ? it.key : it));
    return [prop, ...segments].join('.');
}
// Same key format as AjvValidator so existing error handling keeps working.
function addError(errors, options, path, error) {
    errors = errors || {};
    const key = `${options.dataPath || ''}.${path}`.substring(1);
    (errors[key] || (errors[key] = [])).push(error);
    return errors;
}
