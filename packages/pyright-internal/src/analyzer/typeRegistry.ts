/*
 * typeRegistry.ts
 *
 * Registry of commonly-used Python types (bool, str, dict, tuple, None, etc.)
 * resolved once and accessed without null checks throughout the type evaluator.
 */

import { PythonVersion, pythonVersion3_14 } from '../common/pythonVersion';
import { Uri } from '../common/uri/uri';
import { ParseNode } from '../parser/parseNodes';
import { ImportLookup } from './analyzerFileInfo';
import * as AnalyzerNodeInfo from './analyzerNodeInfo';
import { PrefetchedTypes, TypeEvaluator } from './typeEvaluatorTypes';
import {
    AnyType,
    ClassType,
    ClassTypeFlags,
    Type,
    TypeBase,
    UnknownType,
    isAny,
    isClass,
    isInstantiableClass,
} from './types';
import { computeMroLinearization, convertToInstance } from './typeUtils';

// TypeRegistry is PrefetchedTypes — same fields, but every access site
// can assume non-undefined because the registry is eagerly populated.
export type TypeRegistry = PrefetchedTypes;

// Populate a registry object in place. Fields are set incrementally so
// re-entrant evaluator calls during resolution can see earlier fields,
// matching the original initializePrefetchedTypes behavior.
export function populateTypeRegistry(
    registry: TypeRegistry,
    evaluator: TypeEvaluator,
    importLookup: ImportLookup,
    node: ParseNode
): void {
    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);

    function getTypeOfModule(symbolName: string, nameParts: string[]): Type | undefined {
        const lookupResult = importLookup({ nameParts, importingFileUri: fileInfo.fileUri });
        if (!lookupResult) {
            return undefined;
        }
        const symbol = lookupResult.symbolTable.get(symbolName);
        if (!symbol) {
            return undefined;
        }
        return evaluator.getEffectiveTypeOfSymbol(symbol);
    }

    function getTypesType(symbolName: string): Type | undefined {
        return getTypeOfModule(symbolName, ['types']);
    }

    function getTypeshedType(symbolName: string): Type | undefined {
        return getTypeOfModule(symbolName, ['_typeshed']);
    }

    registry.objectClass = evaluator.getBuiltInType(node, 'object') ?? UnknownType.create();
    registry.typeClass = evaluator.getBuiltInType(node, 'type') ?? UnknownType.create();
    registry.functionClass =
        getTypesType('FunctionType') ?? evaluator.getBuiltInType(node, 'function') ?? UnknownType.create();
    registry.methodClass = getTypesType('MethodType') ?? UnknownType.create();

    registry.unionTypeClass = getTypesType('UnionType') ?? UnknownType.create();
    if (isClass(registry.unionTypeClass)) {
        registry.unionTypeClass.shared.flags |= ClassTypeFlags.SpecialFormClass;
    }

    // Initialize and cache "Collection" to break a cyclical dependency
    // that occurs when resolving tuple below.
    evaluator.getTypingType(node, 'Collection');

    registry.noneTypeClass = getTypeshedType('NoneType') ?? UnknownType.create();
    registry.tupleClass = evaluator.getBuiltInType(node, 'tuple') ?? UnknownType.create();
    registry.boolClass = evaluator.getBuiltInType(node, 'bool') ?? UnknownType.create();
    registry.intClass = evaluator.getBuiltInType(node, 'int') ?? UnknownType.create();
    registry.strClass = evaluator.getBuiltInType(node, 'str') ?? UnknownType.create();
    registry.dictClass = evaluator.getBuiltInType(node, 'dict') ?? UnknownType.create();
    registry.moduleTypeClass = evaluator.getTypingType(node, 'ModuleType') ?? UnknownType.create();
    registry.typedDictPrivateClass =
        evaluator.getTypeCheckerInternalsType(node, 'TypedDictFallback') ??
        evaluator.getTypingType(node, '_TypedDict') ??
        UnknownType.create();
    registry.typedDictClass = evaluator.getTypingType(node, 'TypedDict') ?? UnknownType.create();
    registry.awaitableClass = evaluator.getTypingType(node, 'Awaitable') ?? UnknownType.create();
    registry.mappingClass = evaluator.getTypingType(node, 'Mapping') ?? UnknownType.create();

    if (PythonVersion.isGreaterOrEqualTo(fileInfo.executionEnvironment.pythonVersion, pythonVersion3_14)) {
        registry.templateClass = getTypeOfModule('Template', ['string', 'templatelib']) ?? UnknownType.create();
    } else {
        registry.templateClass = UnknownType.create();
    }

    registry.supportsKeysAndGetItemClass =
        getTypeshedType('SupportsKeysAndGetItem') ?? registry.mappingClass ?? UnknownType.create();

    // Wire up the `Any` class to the special-form version of our internal AnyType.
    if (isInstantiableClass(registry.objectClass) && isInstantiableClass(registry.typeClass)) {
        const anyClass = ClassType.createInstantiable(
            'Any',
            'typing.Any',
            'typing',
            Uri.empty(),
            ClassTypeFlags.BuiltIn | ClassTypeFlags.SpecialFormClass | ClassTypeFlags.IllegalIsinstanceClass,
            /* typeSourceId */ -1,
            /* declaredMetaclass */ undefined,
            /* effectiveMetaclass */ registry.typeClass
        );
        anyClass.shared.baseClasses.push(registry.objectClass);
        computeMroLinearization(anyClass);
        const anySpecialForm = AnyType.createSpecialForm();

        if (isAny(anySpecialForm)) {
            TypeBase.setSpecialForm(anySpecialForm, anyClass);

            if (fileInfo.diagnosticRuleSet.enableExperimentalFeatures) {
                TypeBase.setTypeForm(anySpecialForm, convertToInstance(anySpecialForm));
            }
        }
    }
}
