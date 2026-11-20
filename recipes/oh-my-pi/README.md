# Oh My Pi with Neuralwatt

The setup guide for Oh My Pi is in the Neuralwatt docs: [Oh My Pi](https://docs.neuralwatt.com/integrations/oh-my-pi).

If you copied this recipe's old `config.yml` or `models.yml`, remove or update the `modelRoles` and `task.agentModelOverrides` entries that name retired models, such as `glm-5.2-short` or `deepseek-v4-flash` on the `task` and `tiny` roles. `GET https://api.neuralwatt.com/v1/models` lists the current IDs.
