# vivo 空包签名

`vivo_unsign.apk` 是 vivo 开放平台提供的空包。平台要求用创建应用时的同一把
keystore 写入 MD5/JAR 签名，再上传认领包体。

本仓库的 `.github/workflows/sign-empty.yml` 会用 GitHub Secret `OPENGYM_KS`
（格式 `<base64 keystore>::<password>`，别名 `opengym`）给空包签名，并把结果发布到：

https://github.com/daoshi818-crypto/openGym/releases/tag/vivo-empty-signed

下载 `vivo_empty_signed.apk` 后上传到 vivo 平台的“上传空包”通道即可。
