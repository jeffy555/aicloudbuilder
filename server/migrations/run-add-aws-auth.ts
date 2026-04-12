import "dotenv/config";
import { addAwsAuthColumn } from "./add-aws-auth-column";

addAwsAuthColumn()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
