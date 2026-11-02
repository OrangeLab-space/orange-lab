# SD.Next

|               |                                                                          |
| ------------- | ------------------------------------------------------------------------ |
| Homepage      | https://vladmandic.github.io/sdnext-docs/                                |
| Source code   | https://github.com/vladmandic/sdnext                                     |
| Docker image  | https://hub.docker.com/r/saladtechnologies/sdnext                        |
| Dockerfile    | https://github.com/SaladTechnologies/sdnext-dynamic/blob/main/Dockerfile |
| CLI arguments | https://vladmandic.github.io/sdnext-docs/CLI-Arguments/                  |
| Endpoints     | `https://sdnext.<domain>/`                                               |
|               | `https://sdnext.<domain>/docs`                                           |

```sh
pulumi config set sdnext:enabled true
pulumi up

# disable app and keep model storage
pulumi config set sdnext:storageOnly true
pulumi up
```

SD.Next is another option for image generation with more features and models. It exposes the Automatic1111 API, which is how Open WebUI talks to it.

You can either use the website endpoint or OpenWebUI integration to generate images.
