import { SDLValidationContext } from 'graphql/validation/ValidationContext';
import {
  ASTVisitor,
  Kind,
  EnumTypeDefinitionNode,
  EnumValueDefinitionNode,
  TypeDefinitionNode,
} from 'graphql';
import { errorWithCode, logServiceAndType } from '../../utils';
import { isString } from 'util';
import { ImpactedServicesCompositionError } from '@apollo/federation/src/composition/types';

function isEnumDefinition(node: TypeDefinitionNode) {
  return node.kind === Kind.ENUM_TYPE_DEFINITION;
}

type TypeToDefinitionsMap = {
  [typeNems: string]: TypeDefinitionNode[];
};

export function MatchingEnums(context: SDLValidationContext): ASTVisitor {
  const { definitions } = context.getDocument();

  // group all definitions by name
  // { MyTypeName: [{ serviceName: "A", name: {...}}]}
  let definitionsByName: {
    [typeName: string]: TypeDefinitionNode[];
  } = (definitions as TypeDefinitionNode[]).reduce(
    (typeToDefinitionsMap: TypeToDefinitionsMap, node) => {
      const name = node.name.value;
      if (typeToDefinitionsMap[name]) {
        typeToDefinitionsMap[name].push(node);
      } else {
        typeToDefinitionsMap[name] = [node];
      }
      return typeToDefinitionsMap;
    },
    {},
  );

  // map over each group of definitions.
  for (const [name, definitions] of Object.entries(definitionsByName)) {
    // if every definition in the list is an enum, we don't need to error about type,
    // but we do need to check to make sure every service has the same enum values
    if (definitions.every(isEnumDefinition)) {
      // a simple list of services to enum values for a given enum
      // [{ serviceName: "serviceA", values: ["FURNITURE", "BOOK"] }]
      let simpleEnumDefs: Array<{ serviceName: string; values: string[], nodes: readonly EnumValueDefinitionNode[]}> = [];

      // build the simpleEnumDefs list
      for (const {
        values,
        serviceName,
      } of definitions as EnumTypeDefinitionNode[]) {
        if (serviceName && values)
          simpleEnumDefs.push({
            serviceName,
            values: values.map(
              (enumValue: EnumValueDefinitionNode) => enumValue.name.value,
            ),
            nodes: values
          });
      }

      // values need to be in order to build the matchingEnumGroups
      for (const definition of simpleEnumDefs) {
        definition.values = definition.values.sort();
      }

      // groups of services with matching values, keyed by enum values
      // like {"FURNITURE,BOOK": ["ServiceA", "ServiceB"], "FURNITURE,DIGITAL": ["serviceC"]}
      let matchingEnumGroups: { [values: string]: {serviceName: string, nodes: readonly EnumValueDefinitionNode[] }[]} = {};

      // build matchingEnumDefs
      for (const definition of simpleEnumDefs) {
        const key = definition.values.join();
        const serviceWithNodes  = {serviceName: definition.serviceName, nodes: definition.nodes };
        if (matchingEnumGroups[key]) {
          matchingEnumGroups[key].push(serviceWithNodes);
        } else {
          matchingEnumGroups[key] = [serviceWithNodes];
        }
      }

      if (Object.keys(matchingEnumGroups).length > 1) {
        let impactedServices: ImpactedServicesCompositionError = {};
        // Object.values(matchingEnumGroups).map(serviceNames => serviceNames.map(serviceName=> impactedServices[serviceName] = null));

        context.reportError(
          errorWithCode(
            'ENUM_MISMATCH',
            impactedServices,
            `The \`${name}\` enum does not have identical values in all services. Groups of services with identical values are: ${Object.values(
              matchingEnumGroups,
            )
              .map(serviceNames => `[${serviceNames.join(', ')}]`)
              .join(', ')}`,
          ),
        );
      }
    } else if (definitions.some(isEnumDefinition)) {
      let impactedServices: ImpactedServicesCompositionError = {};
      // if only SOME definitions in the list are enums, we need to error

      // first, find the services, where the defs ARE enums
      const servicesWithEnum = definitions
        .filter(isEnumDefinition)
        .map(definition => definition.serviceName)
        .filter(isString);

      // find the services where the def isn't an enum
      const servicesWithoutEnum = definitions
        .filter(d => !isEnumDefinition(d))
        .map(d => d.serviceName)
        .filter(isString);

      context.reportError(
        errorWithCode(
          'ENUM_MISMATCH_TYPE',
          impactedServices,
          logServiceAndType(servicesWithEnum[0], name) +
            `${name} is an enum in [${servicesWithEnum.join(
              ', ',
            )}], but not in [${servicesWithoutEnum.join(', ')}]`,
        ),
      );
    }
  }

  // we don't need any visitors for this validation rule
  return {};
}
