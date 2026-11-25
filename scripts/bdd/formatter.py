"""Include the actual Examples values in Behave's JSON results."""
from behave.formatter.json import JSONFormatter
from scripts.bdd.coverage import example_values


class BehaviorJSONFormatter(JSONFormatter):
    def scenario(self, scenario):
        super().scenario(scenario)
        example = example_values(scenario)
        if example is not None:
            self.current_feature_element['example'] = example
