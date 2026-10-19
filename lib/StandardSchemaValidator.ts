import type { ModelClass, ModelOptions, Pojo, ValidatorArgs } from 'objection';
import type { StandardSchemaV1 } from './types';
import { Validator } from 'objection';
import { ValidationError } from './objection';
import { validateSync } from './standardSchema';

/** A column as the validator sees it (see `normalizeColumns`). */
export interface ValidatedColumn {
  readonly prop: string;
  readonly schema: StandardSchemaV1;
  readonly generated: boolean;
  readonly hasDefault: boolean;
  readonly undefinedMode: 'required' | 'optional' | 'default';
}

// objection passes these as well, but doesn't declare them.
interface ValidateOptions extends ModelOptions {
  mutable?: boolean;
  dataPath?: string;
}

interface ErrorItem {
  message: string;
  keyword: string;
  params: object;
}

type Errors = Record<string, ErrorItem[]>;

// Validates each column with its own Standard Schema. Validating per column
// (instead of one object schema) makes patch validation free: only the given
// properties are validated and no `.partial()` copy of the schema is needed.
export class StandardSchemaValidator extends Validator {
  private readonly columns: readonly ValidatedColumn[];

  // A constructor, not `static init()`: objection exports `Validator` wrapped in an
  // ES5 function that calls the built-in `init` directly, so a subclass's would never run.
  constructor({ columns }: { columns: readonly ValidatedColumn[] }) {
    super();
    this.columns = columns;
  }

  validate({ model, json, options }: ValidatorArgs): Pojo {
    const columns = this.columns;
    const opts: ValidateOptions = options;
    const patch = !!opts.patch;
    let output = json;
    let errors: Errors | null = null;

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
        result = validateSync(col.schema, undefined, col.prop);
      }
      else {
        result = validateSync(col.schema, value, col.prop);
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
      throw (model.constructor as ModelClass<typeof model>).createValidationError({
        type: ValidationError.Type.ModelValidation,
        data: errors,
      });
    }

    return output;
  }
}

function issuePath(prop: string, issue: StandardSchemaV1.Issue): string {
  // Stryker disable next-line ConditionalExpression: an empty path joins to just `prop` anyway.
  if (!issue.path || issue.path.length === 0) {
    return prop;
  }

  const segments = issue.path.map(it => (typeof it === 'object' ? it.key : it));

  return [prop, ...segments].join('.');
}

// Same key format as AjvValidator so existing error handling keeps working.
function addError(
  errors: Errors | null,
  options: ValidateOptions,
  path: string,
  error: ErrorItem,
): Errors {
  errors = errors || {};

  const key = `${options.dataPath || ''}.${path}`.substring(1);
  (errors[key] || (errors[key] = [])).push(error);

  return errors;
}
