// Member access, descriptor protocol, and method binding functions
// extracted from typeEvaluator.ts.

import { assert } from '../common/debug';
import { ParamCategory } from '../parser/parseNodes';
import { TypeEvaluator } from './typeEvaluatorTypes';
import {
    ClassType,
    FunctionParam,
    FunctionParamFlags,
    FunctionType,
    isClassInstance,
    isInstantiableClass,
    isNever,
    Type,
    UnknownType,
} from './types';
import { ClassMember, partiallySpecializeType } from './typeUtils';

// If the function includes a `**kwargs: Unpack[TypedDict]` parameter, the
// parameter is expanded to include individual keyword args.
export function expandTypedKwargs(functionType: FunctionType): FunctionType {
    const kwargsIndex = functionType.shared.parameters.findIndex(
        (param) => param.category === ParamCategory.KwargsDict
    );
    if (kwargsIndex < 0) {
        return functionType;
    }
    assert(kwargsIndex === functionType.shared.parameters.length - 1);

    const kwargsType = FunctionType.getParamType(functionType, kwargsIndex);
    if (!isClassInstance(kwargsType) || !ClassType.isTypedDictClass(kwargsType) || !kwargsType.priv.isUnpacked) {
        return functionType;
    }

    const tdEntries = kwargsType.priv.typedDictNarrowedEntries ?? kwargsType.shared.typedDictEntries?.knownItems;
    if (!tdEntries) {
        return functionType;
    }

    const newFunction = FunctionType.clone(functionType);
    newFunction.shared.parameters.splice(kwargsIndex);
    if (newFunction.priv.specializedTypes) {
        newFunction.priv.specializedTypes.parameterTypes.splice(kwargsIndex);
    }

    const kwSeparatorIndex = functionType.shared.parameters.findIndex(
        (param) => param.category === ParamCategory.ArgsList
    );

    // Add a keyword separator if necessary.
    if (kwSeparatorIndex < 0 && tdEntries.size > 0) {
        FunctionType.addKeywordOnlyParamSeparator(newFunction);
    }

    tdEntries.forEach((tdEntry, name) => {
        FunctionType.addParam(
            newFunction,
            FunctionParam.create(
                ParamCategory.Simple,
                tdEntry.valueType,
                FunctionParamFlags.TypeDeclared,
                name,
                tdEntry.isRequired ? undefined : tdEntry.valueType
            )
        );
    });

    const extraItemsType = kwargsType.shared.typedDictEntries?.extraItems?.valueType;

    if (extraItemsType && !isNever(extraItemsType)) {
        FunctionType.addParam(
            newFunction,
            FunctionParam.create(
                ParamCategory.KwargsDict,
                extraItemsType,
                FunctionParamFlags.TypeDeclared,
                'kwargs'
            )
        );
    }

    return newFunction;
}

export function getTypeOfMember(evaluator: TypeEvaluator, member: ClassMember): Type {
    if (isInstantiableClass(member.classType)) {
        return partiallySpecializeType(
            evaluator.getEffectiveTypeOfSymbol(member.symbol),
            member.classType,
            evaluator.getTypeClassType(),
            /* selfClass */ undefined
        );
    }
    return UnknownType.create();
}

export function getGetterTypeFromProperty(evaluator: TypeEvaluator, propertyClass: ClassType): Type | undefined {
    if (!ClassType.isPropertyClass(propertyClass)) {
        return undefined;
    }

    if (propertyClass.priv.fgetInfo) {
        return (
            FunctionType.getEffectiveReturnType(propertyClass.priv.fgetInfo.methodType) ??
            evaluator.getInferredReturnType(propertyClass.priv.fgetInfo.methodType)
        );
    }

    return undefined;
}
