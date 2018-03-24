import * as OperationTypes from "./OperationTypes";
import { createOperation, ignoredArrayExpression } from "./babelPluginHelpers";

const operations = {
  memberExpression: {
    createNode({ object, propName }) {
      return createOperation(OperationTypes.memberExpression, {
        object,
        propName
      });
    }
  }
};

export default operations;
